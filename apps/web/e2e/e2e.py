"""End-to-end run of Claim! through the real UI: one seller and two buyers, in separate browser contexts.

Usage: python e2e/e2e.py [base_url] [out_dir]
Needs a running server in mock payments mode. Exits non-zero when any check fails.

Covers: landing -> demo, voice listing, buyer join + Claim Pass, tap-to-claim, chat claims,
live updates across contexts, review lane (keyboard, approve-all), simulation, mobile seller header,
audit drawer, end show, close-out charge with a decline, buyer pay-now through /pay, refund
(including a double submit), tracking, buyer receipt, reload persistence, dark mode, console errors.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3011"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "e2e/out/e2e")
OUT.mkdir(parents=True, exist_ok=True)
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}

results: list[tuple[str, bool, str]] = []
console_errors: list[str] = []


def api(path, body=None):
    req = urllib.request.Request(BASE + path, method="POST" if body is not None else "GET")
    if body is not None:
        req.add_header("content-type", "application/json")
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def post_raw(path, raw, headers):
    """POST exact bytes and return (status, json) for 4xx/5xx too, unlike api()."""
    req = urllib.request.Request(BASE + path, method="POST", data=raw.encode())
    req.add_header("content-type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def fnv1a(s):
    """The mock gateway's fnv1a over UTF-16 code units, as JavaScript's charCodeAt sees them."""
    h = 0x811C9DC5
    units = s.encode("utf-16-le")
    for i in range(0, len(units), 2):
        h ^= units[i] | (units[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        h, r = divmod(h, 36)
        out = digits[r] + out
        if not h:
            return out


def signed(event, transmission_id):
    """A webhook delivery the mock-mode server verifies, signed the way its mock gateway signs."""
    raw = json.dumps(event)
    time_ = "2026-10-05T00:00:00.000Z"
    return raw, {
        "paypal-auth-algo": "MOCKFNV1A",
        "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/MOCK",
        "paypal-transmission-id": transmission_id,
        "paypal-transmission-sig": "mock-" + fnv1a(f"{transmission_id}|{time_}|WEBHOOK_ID|{raw}"),
        "paypal-transmission-time": time_,
    }


def charge_of(show, name):
    v = api(f"/api/shows/{show}?scope=seller")
    carts = {c["cartId"] for b in v["carts"] if b["displayName"] == name for c in b["finalized"]}
    return [c for c in v["charges"] if c["cartId"] in carts and c["status"] == "COMPLETED"][-1]


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    return ok


def step(name, fn, page=None):
    try:
        fn()
        check(name, True)
        return True
    except Exception as e:  # noqa: BLE001 - every failure is recorded, then the run goes on
        if page is not None:
            try:
                page.screenshot(path=str(OUT / f"FAIL-{re.sub(r'[^a-z0-9]+', '-', name.lower())}.png"), full_page=True)
            except Exception:
                pass
        check(name, False, " | ".join(l.strip() for l in str(e).splitlines() if l.strip())[:600])
        return False


def watch(page, label):
    page.on("console", lambda m: console_errors.append(f"{label}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"{label}: pageerror {e}"))


def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - window.innerWidth")


def join(page, show, name):
    page.goto(f"{BASE}/live/{show}")
    page.wait_for_load_state("networkidle")
    page.get_by_label("Pick a chat name to claim").fill(name)
    page.get_by_role("button", name="Join").click()
    expect(page.get_by_placeholder(re.compile(f"Chat as {name}"))).to_be_visible()


def link_pass(page, declines=False):
    page.get_by_role("button", name="Get Claim Pass").click()
    sheet = page.get_by_role("dialog")
    expect(sheet).to_be_visible()
    sheet.get_by_role("button", name="$100").click()
    if declines:
        sheet.get_by_label("card declines at close-out").check()
    sheet.get_by_role("button", name=re.compile(r"Save\s*Pay\s*Pal")).click()
    expect(page.get_by_text("Claim Pass linked").first).to_be_visible()
    expect(sheet).to_be_hidden()


def chat(page, text):
    page.locator("#chat-input").fill(text)
    page.get_by_role("button", name="Send").click()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        seller_ctx = browser.new_context(viewport=DESKTOP)
        seller = seller_ctx.new_page()
        watch(seller, "seller")
        show = ""

        # ---------- landing -> demo ----------
        def landing():
            nonlocal show
            seller.goto(BASE + "/")
            seller.wait_for_load_state("networkidle")
            expect(seller.get_by_role("heading", level=1)).to_contain_text("Say it on air")
            seller.get_by_role("button", name="Start a demo show").click()
            seller.wait_for_url(re.compile(r"/demo/show-"), timeout=15000)
            show = seller.url.rstrip("/").split("/")[-1]
            expect(seller.frame_locator('iframe[title="Seller console"]').get_by_role("heading", name="Live comments")).to_be_visible(timeout=15000)
            expect(seller.frame_locator('iframe[title="Buyer room"]').get_by_placeholder(re.compile("Chat as jess"))).to_be_visible(timeout=15000)
            seller.screenshot(path=str(OUT / "01-demo.png"))

        if not step("landing starts a seeded demo show with both panes live", landing, seller):
            return finish(browser)

        # ---------- seller console: start + voice listing ----------
        def console_ready():
            seller.goto(f"{BASE}/seller/{show}")
            seller.wait_for_load_state("networkidle")
            expect(seller.get_by_role("heading", name="Live comments")).to_be_visible()
            start = seller.get_by_role("button", name="Start show")
            if start.count():
                start.click()
                expect(seller.get_by_text("You're live")).to_be_visible()

        step("seller console loads and the show starts", console_ready, seller)

        def voice():
            seller.get_by_role("button", name="Use a sample").click()
            seller.get_by_role("button", name="Draft listing").click()
            confirm = seller.get_by_role("button", name="Confirm and put on air")
            expect(confirm).to_be_visible(timeout=15000)
            if confirm.is_disabled():
                # The sample leaves one field for the seller to confirm; fill every empty draft input.
                for el in seller.locator("form input, div.anim-drop input").all():
                    if el.is_visible() and not el.input_value().strip():
                        label = (el.get_attribute("aria-label") or "").lower()
                        el.fill("sage" if "colour" in label else "1" if "quantity" in label else "36" if "price" in label else "x")
            expect(confirm).to_be_enabled()
            confirm.click()
            expect(seller.locator("#onair-title")).to_contain_text(re.compile("linen", re.I), timeout=10000)
            seller.get_by_role("button", name=re.compile(r"^#12 ")).click()
            expect(seller.locator("#onair-title")).to_contain_text(re.compile("cardigan", re.I))

        step("voice listing drafts #9 from the sample, confirms it on air, run sheet switches back to #12", voice, seller)

        # ---------- buyers ----------
        jess_ctx = browser.new_context(viewport=PHONE, is_mobile=True, has_touch=True)
        jess = jess_ctx.new_page()
        watch(jess, "jess")
        maya_ctx = browser.new_context(viewport=PHONE, is_mobile=True, has_touch=True)
        maya = maya_ctx.new_page()
        watch(maya, "maya")

        def buyers_join():
            join(jess, show, "jess")
            link_pass(jess)
            join(maya, show, "maya")
            link_pass(maya, declines=True)
            check("buyer room has no sideways scroll on a phone", overflow(jess) <= 0, f"{overflow(jess)}px")

        step("two buyers join and link a Claim Pass (maya's card is set to decline)", buyers_join, jess)

        def tap_claim():
            jess.get_by_role("button", name=re.compile(r"Claim #12 · M")).click()
            mine = jess.locator("section[aria-labelledby=mine-title]")
            expect(mine.get_by_text("YOURS")).to_be_visible(timeout=10000)
            # The seller's stream updates over SSE without a reload.
            expect(seller.locator("ol").get_by_text("sold 12 M").first).to_be_visible(timeout=10000)

        step("jess taps to claim #12 M: YOURS on her phone, comment appears live in the seller stream", tap_claim, jess)

        def chat_claim():
            chat(maya, "sold 12 L")
            expect(maya.locator("section[aria-labelledby=mine-title]").get_by_text("YOURS")).to_be_visible(timeout=10000)
            jess.screenshot(path=str(OUT / "02-buyer-claimed.png"))

        step("maya claims #12 L by typing in chat", chat_claim, maya)

        # ---------- review lane ----------
        def review_lane():
            for uid, name, text in [("ava-e2e", "ava", "SOLD!!!"), ("rosie-e2e", "rosie", "12 L pakka"), ("zara-e2e", "zara", "M wala mera"), ("ivy-e2e", "ivy", "me me me")]:
                r = api(f"/api/shows/{show}", {"action": "comment", "userId": uid, "displayName": name, "text": text})
                assert r.get("ok"), r
            lane = seller.locator("section[aria-labelledby=review-title]")
            cards = lane.locator("[data-review-id]")
            expect(cards).to_have_count(4, timeout=10000)
            expect(lane.get_by_text("Resolver detail").first).to_be_visible()
            assert "needs review (" not in lane.locator("p.text-muted").first.inner_text(), "plain reason shows the raw resolver text"
            # Keyboard: J/K move focus, R rejects the focused card ("me me me", the one with no item), focus stays in the lane.
            cards.first.focus()
            for _ in range(3):
                seller.keyboard.press("j")
            seller.keyboard.press("k")
            seller.keyboard.press("j")
            last = cards.nth(3)
            assert seller.evaluate("document.activeElement.dataset.reviewId") == last.get_attribute("data-review-id"), "J/K did not move focus"
            assert "me me me" in last.inner_text(), last.inner_text()
            seller.keyboard.press("r")
            expect(cards).to_have_count(3, timeout=10000)
            assert seller.evaluate("!!document.activeElement.dataset.reviewId"), "focus left the lane after R"
            # A claim with no variant cannot be approved until the seller picks one.
            ava = lane.locator("[data-review-id]", has_text="SOLD!!!")
            if ava.count():
                expect(ava.get_by_role("button", name="Pick a variant to approve")).to_be_disabled()
            bulk = lane.get_by_role("button", name=re.compile(r"Approve \d+ ready"))
            assert bulk.count(), "no approve-all button with two ready claims (12 L pakka, M wala mera)"
            if bulk.count():
                n = int(re.search(r"\d+", bulk.inner_text()).group())
                before = cards.count()
                bulk.click()
                expect(cards).to_have_count(before - n, timeout=15000)
                check("approve-all clears every ready review", True, f"{n} approved")
            if ava.count():
                ava.get_by_label("Variant").select_option(index=1)
                ava.get_by_role("button", name=re.compile(r"^Approve")).click()
                expect(ava).to_have_count(0, timeout=10000)
            for c in cards.all():
                c.focus()
                seller.keyboard.press("r")
            expect(cards).to_have_count(0, timeout=10000)
            expect(lane.get_by_text("Nothing needs you")).to_be_visible()

        step("review lane: plain reasons, J/R keyboard, approve-all, pick-a-variant approve", review_lane, seller)

        def simulate():
            before = len(api(f"/api/shows/{show}")["comments"])
            seller.get_by_label("Simulation scenario").select_option("slang")
            seller.get_by_role("button", name="Simulate").click()
            expect(seller.get_by_role("button", name="Running")).to_be_visible(timeout=5000)
            expect(seller.get_by_role("button", name="Simulate")).to_be_visible(timeout=30000)
            after = len(api(f"/api/shows/{show}")["comments"])
            assert after > before, f"comments {before} -> {after}"
            seller.screenshot(path=str(OUT / "03-seller-live.png"))

        step("simulation runs from the header and fills the stream", simulate, seller)

        def audit():
            seller.get_by_role("button", name="Open the audit log").click()
            expect(seller.get_by_role("dialog")).to_be_visible()
            seller.keyboard.press("Escape")
            expect(seller.get_by_role("dialog")).to_be_hidden()

        step("audit drawer opens and closes with Escape", audit, seller)

        def seller_phone():
            ctx = browser.new_context(viewport=PHONE)
            pg = ctx.new_page()
            watch(pg, "seller-phone")
            pg.goto(f"{BASE}/seller/{show}")
            pg.wait_for_load_state("networkidle")
            assert overflow(pg) <= 0, f"page scrolls sideways by {overflow(pg)}px"
            end = pg.get_by_role("button", name="End show")
            end.scroll_into_view_if_needed()
            assert end.is_visible(), "End show is not reachable"
            for name in ("Open the buyer room", "Open the audit log"):
                box = pg.get_by_label(name).bounding_box()
                assert box and box["height"] >= 32 and box["width"] >= 32, f"{name} target {box}"
            pg.screenshot(path=str(OUT / "04-seller-phone.png"))
            ctx.close()

        step("seller console on a phone: no sideways scroll, actions reachable, icon buttons labelled", seller_phone, seller)

        # ---------- close-out ----------
        def end_and_charge():
            seller.get_by_role("button", name="End show").click()
            seller.wait_for_url(re.compile(r"/closeout$"), timeout=10000)
            charge = seller.get_by_role("button", name=re.compile(r"Charge \d+ Claim Pass cart"))
            expect(charge).to_be_visible(timeout=10000)
            seller.screenshot(path=str(OUT / "05-closeout-before.png"), full_page=True)
            charge.click()
            expect(seller.get_by_text(re.compile(r"Charged \d+ buyer"))).to_be_visible(timeout=20000)
            jess_card = seller.locator("li", has=seller.get_by_text("jess", exact=True)).first
            expect(jess_card.get_by_text("CHARGED", exact=True)).to_be_visible()
            maya_card = seller.locator("li", has=seller.get_by_text("maya", exact=True)).first
            expect(maya_card.get_by_text("DECLINED", exact=True)).to_be_visible()
            expect(seller.get_by_text(re.compile("Every Claim Pass cart is charged|No Claim Pass carts to charge"))).to_be_visible()
            seller.screenshot(path=str(OUT / "06-closeout-after.png"), full_page=True)

        step("end show -> close-out charges Claim Pass carts: jess charged, maya declined", end_and_charge, seller)

        def ship_to():
            address = seller.locator('address[aria-label="Ship to for jess"]')
            expect(address).to_be_visible(timeout=10000)
            expect(address).to_contain_text("Main St")
            expect(address).to_contain_text("San Jose, CA 95131")
            seller_json = json.dumps(api(f"/api/shows/{show}?scope=seller"))
            public_json = json.dumps(api(f"/api/shows/{show}"))
            assert "Main St" in seller_json, "seller view has no address"
            assert "Main St" not in public_json and "95131" not in public_json, "public view leaks an address"
            jess.reload()
            jess.wait_for_load_state("networkidle")
            time.sleep(1)
            assert "Main St" not in jess.content(), "buyer room page carries an address"
            address.screenshot(path=str(OUT / "06b-ship-to.png"))

        step("charged cart shows the wallet's ship-to address; buyer rooms and the public API never get it", ship_to, seller)

        def buyer_pays():
            maya.reload()
            maya.wait_for_load_state("networkidle")
            expect(maya.get_by_text("Your Claim Pass charge didn't go through")).to_be_visible(timeout=10000)
            maya.screenshot(path=str(OUT / "07-buyer-owes.png"), full_page=True)
            maya.get_by_role("button", name=re.compile(r"Pay \$[\d.]+ \+ shipping")).click()
            maya.wait_for_url(re.compile(r"/pay/"), timeout=15000)
            maya.get_by_role("button", name=re.compile(r"Pay with\s*Pay\s*Pal")).click()
            expect(maya.get_by_text("PAID").first).to_be_visible(timeout=15000)
            maya.screenshot(path=str(OUT / "08-pay-done.png"), full_page=True)
            maya.get_by_role("link", name="Back to the show").click()
            maya.wait_for_load_state("networkidle")
            expect(maya.get_by_text("Your Claim Pass charge didn't go through")).to_be_hidden(timeout=10000)

        step("declined buyer sees what she owes, pays through PayPal pay-now, the debt clears", buyer_pays, maya)

        def pay_now_address():
            seller.reload()
            seller.wait_for_load_state("networkidle")
            address = seller.locator('address[aria-label="Ship to for maya"]')
            expect(address).to_be_visible(timeout=10000)
            expect(address).to_contain_text("Main St")

        step("a pay-now capture brings the buyer's PayPal address to close-out", pay_now_address, seller)

        def ledger_ship_to():
            pg = browser.new_context(viewport=DESKTOP, accept_downloads=True).new_page()
            watch(pg, "ledger")
            pg.goto(f"{BASE}/seller/{show}/ledger")
            pg.wait_for_selector(".ag-root-wrapper", timeout=20000)
            expect(pg.locator(".ag-header-cell", has_text="Ship to")).to_be_visible()
            cells = pg.locator('.ag-row[row-id] .ag-cell[col-id="shipTo"]')
            expect(cells.filter(has_text="Main St").first).to_be_visible(timeout=10000)
            with pg.expect_download() as dl:
                pg.get_by_role("button", name="Export CSV").click()
            text = Path(dl.value.path()).read_text()
            assert "Ship to" in text.splitlines()[0], text.splitlines()[0]
            assert "Main St" in text, "CSV has no addresses"
            pg.screenshot(path=str(OUT / "06c-ledger-ship-to.png"))
            pg.context.close()

        step("ledger shows a Ship to column and exports it in the CSV", ledger_ship_to, seller)

        def refund_and_track():
            seller.reload()
            seller.wait_for_load_state("networkidle")
            jess_card = seller.locator("li", has=seller.get_by_text("jess", exact=True)).first
            jess_card.get_by_role("button", name="Refund").click()
            amount = jess_card.get_by_label("Refund amount in dollars")
            amount.fill("5")
            submit = jess_card.locator("form").get_by_role("button", name="Refund")
            # Double submit: two clicks before the first response lands must refund once.
            submit.evaluate("b => { b.click(); b.click(); }")
            expect(jess_card.get_by_text(re.compile(r"Refunded \$5\.00"))).to_be_visible(timeout=10000)
            time.sleep(1)
            refunds = [r for r in api(f"/api/shows/{show}")["refunds"] if r["amountCents"] == 500]
            assert len(refunds) == 1, f"{len(refunds)} refunds of $5 after a double submit"
            jess_card.get_by_role("button", name="Add tracking").click()
            jess_card.get_by_label("Tracking number").fill("9400E2E0001")
            jess_card.get_by_role("button", name="Save").click()
            expect(jess_card.get_by_text("9400E2E0001")).to_be_visible(timeout=10000)

        step("refund (double submit refunds once) and tracking on jess's cart", refund_and_track, seller)

        def webhooks():
            c = charge_of(show, "jess")
            done = {"id": "WH-E2E-CAP", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource_type": "capture",
                    "resource": {"id": c["captureId"], "status": "COMPLETED", "supplementary_data": {"related_ids": {"order_id": c["orderId"]}}}}
            raw, headers = signed(done, "e2e-1")
            status, body = post_raw("/api/paypal/webhook", raw, headers)
            assert (status, body.get("matched")) == (200, 1), (status, body)
            status, body = post_raw("/api/paypal/webhook", raw, headers)
            assert status == 200 and body.get("duplicate") is True, (status, body)
            status, body = post_raw("/api/paypal/webhook", raw.replace("COMPLETED", "REVERSED", 1), headers)
            assert status == 401, (status, body)
            status, body = post_raw("/api/paypal/webhook", raw, {})
            assert status == 401, (status, body)
            refund = {"id": "WH-E2E-REF", "event_type": "PAYMENT.CAPTURE.REFUNDED", "resource_type": "refund",
                      "resource": {"id": "E2EREFUND", "links": [{"rel": "up", "href": f"https://api.sandbox.paypal.com/v2/payments/captures/{c['captureId']}"}]}}
            status, body = post_raw("/api/paypal/webhook", *signed(refund, "e2e-2"))
            assert (status, body.get("matched")) == (200, 1), (status, body)
            jess_card = seller.locator("li", has=seller.get_by_text("jess", exact=True)).first
            expect(jess_card.get_by_text(re.compile(r"confirmed by PayPal · refund confirmed by PayPal"))).to_be_visible(timeout=10000)
            reversal = {"id": "WH-E2E-REV", "event_type": "PAYMENT.CAPTURE.REVERSED", "resource_type": "refund",
                        "resource": {"id": "E2EREVERSAL", "links": [{"rel": "up", "href": f"https://api.sandbox.paypal.com/v2/payments/captures/{c['captureId']}"}]}}
            status, body = post_raw("/api/paypal/webhook", *signed(reversal, "e2e-3"))
            assert (status, body.get("matched")) == (200, 1), (status, body)
            expect(jess_card.get_by_role("alert").filter(has_text="PayPal reversed the payment")).to_be_visible(timeout=10000)
            jess_card.screenshot(path=str(OUT / "09b-webhooks.png"))

        step("signed PayPal webhooks: confirmation, refund, reversal reach the cart; replays dedupe, forgeries get 401", webhooks, seller)

        def buyer_receipt():
            jess.reload()
            jess.wait_for_load_state("networkidle")
            expect(jess.get_by_role("heading", name="You're all paid")).to_be_visible(timeout=10000)
            expect(jess.get_by_text("Refunded $5.00")).to_be_visible()
            expect(jess.get_by_text(re.compile(r"Shipped · USPS 9400E2E0001"))).to_be_visible()
            jess.screenshot(path=str(OUT / "09-buyer-receipt.png"), full_page=True)

        step("buyer receipt shows the charge, the refund and tracking", buyer_receipt, jess)

        def persistence():
            seller.reload()
            seller.wait_for_load_state("networkidle")
            jess_card = seller.locator("li", has=seller.get_by_text("jess", exact=True)).first
            expect(jess_card.get_by_text("CHARGED", exact=True)).to_be_visible()
            expect(jess_card.get_by_text("9400E2E0001")).to_be_visible()

        step("close-out survives a reload", persistence, seller)

        def dark():
            ctx = browser.new_context(viewport=DESKTOP, color_scheme="dark")
            pg = ctx.new_page()
            watch(pg, "dark")
            for path, name in [(f"/seller/{show}", "seller"), (f"/seller/{show}/closeout", "closeout"), ("/", "landing")]:
                pg.goto(BASE + path)
                pg.wait_for_load_state("networkidle")
                bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
                lum = sum(int(x) for x in re.findall(r"\d+", bg)[:3])
                assert lum < 200, f"{name} body background {bg} is not dark"
                pg.screenshot(path=str(OUT / f"10-dark-{name}.png"))
            pg.get_by_role("button", name="Switch to light theme").click()
            assert pg.evaluate("document.documentElement.dataset.theme") == "light"
            ctx.close()

        step("dark mode follows the system and the toggle switches it", dark, seller)

        finish(browser)


def finish(browser):
    browser.close()
    check("no console errors on any page", not console_errors, "; ".join(console_errors[:3]))
    failed = [r for r in results if not r[1]]
    (OUT / "results.json").write_text(json.dumps({"results": results, "consoleErrors": console_errors}, indent=2))
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
