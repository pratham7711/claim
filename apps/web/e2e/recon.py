"""Screenshot every screen at desktop and mobile, light and dark, and list each screen's controls.

Usage: python e2e/recon.py [base_url] [out_dir]
Drives show state through the HTTP API so each screen is captured in a realistic state.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3011"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "e2e/out/recon")
OUT.mkdir(parents=True, exist_ok=True)

VIEWPORTS = {"desktop": {"width": 1440, "height": 900}, "mobile": {"width": 390, "height": 844}}


def api(path, body=None):
    req = urllib.request.Request(BASE + path, method="POST" if body is not None else "GET")
    if body is not None:
        req.add_header("content-type", "application/json")
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def act(show, body):
    return api(f"/api/shows/{show}", body)


def controls(page):
    names = []
    for role in ("button", "link", "textbox", "combobox", "checkbox", "tab"):
        for el in page.get_by_role(role).all():
            try:
                if not el.is_visible():
                    continue
                n = (el.get_attribute("aria-label") or el.inner_text() or el.get_attribute("placeholder") or "").strip().replace("\n", " ")
                names.append(f"{role}:{n[:50]}")
            except Exception:
                pass
    return names


def shoot(browser, name, url, report, themes=("light", "dark"), sizes=("desktop", "mobile")):
    for size in sizes:
        for theme in themes:
            ctx = browser.new_context(viewport=VIEWPORTS[size], color_scheme=theme, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.goto(url)
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(600)
            page.screenshot(path=str(OUT / f"{name}-{size}-{theme}.png"), full_page=True)
            overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            small = page.evaluate(
                """() => [...document.querySelectorAll('button, a, input, select, [role=button]')]
                  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32) })
                  .map(e => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))"""
            )
            key = f"{name}/{size}/{theme}"
            report[key] = {"errors": errors, "hOverflowPx": overflow, "smallTargets": small[:15]}
            if theme == "light":
                report[key]["controls"] = controls(page)
            ctx.close()


def main():
    report = {}
    show = api("/api/shows", {"seed": True})["showId"]
    act(show, {"action": "start"})
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        shoot(browser, "01-landing", BASE + "/", report)
        shoot(browser, "02-seller-empty", f"{BASE}/seller/{show}", report, sizes=("desktop", "mobile"))
        for scenario in ("race", "slang", "hinglish", "bundle"):
            act(show, {"action": "simulate", "scenario": scenario})
            time.sleep(5)
        act(show, {"action": "comment", "userId": "jess", "displayName": "jess", "text": "sold 12 L"})
        shoot(browser, "03-seller-live", f"{BASE}/seller/{show}", report)
        shoot(browser, "04-demo", f"{BASE}/demo/{show}", report, sizes=("desktop",))
        shoot(browser, "05-buyer", f"{BASE}/live/{show}?as=jess", report)
        act(show, {"action": "end"})
        shoot(browser, "06-closeout-before", f"{BASE}/seller/{show}/closeout", report, themes=("light",))
        act(show, {"action": "chargeAll"})
        shoot(browser, "07-closeout-after", f"{BASE}/seller/{show}/closeout", report)
        view = api(f"/api/shows/{show}")
        declined = [c for c in view["carts"] if any(f["status"] == "declined" for f in c["finalized"])]
        if declined:
            r = act(show, {"action": "payNowHolds", "buyerKey": declined[0]["buyerKey"]})
            url = r.get("data", {}).get("approveUrl")
            report["payNowOrder"] = r
            if url:
                shoot(browser, "08-pay", url, report)
        shoot(browser, "09-buyer-ended", f"{BASE}/live/{show}?as=dana", report, themes=("light",))
        browser.close()
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print("show", show)
    for k, v in report.items():
        if k == "payNowOrder":
            continue
        flag = []
        if v["errors"]:
            flag.append(f"{len(v['errors'])} console errors: {v['errors'][:2]}")
        if v["hOverflowPx"] > 0:
            flag.append(f"horizontal overflow {v['hOverflowPx']}px")
        print(k, "|", "; ".join(flag) or "clean", "| small targets:", len(v["smallTargets"]))


if __name__ == "__main__":
    main()
