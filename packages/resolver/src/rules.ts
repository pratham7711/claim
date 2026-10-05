import type { IntentKind, ResolverContext, ShowItem } from "@claim/core";
import {
  canonColor,
  colorAliases,
  COLOR_SYNONYMS,
  COLOR_WORDS,
  matchSize,
  NUMBER_WORDS,
  SIZE_BIGRAMS,
  SIZE_WORDS,
  sizesOf,
  variantFit,
} from "./lexicon.js";
import { glued, normalize, type Token } from "./normalize.js";

export interface RuleIntent {
  kind: IntentKind;
  itemCode?: string;
  size?: string;
  color?: string;
  qty?: number;
  /** For "change": the claim being given up, when the comment names it. */
  fromItemCode?: string;
  confidence: number;
  rationale: string;
}

export interface RuleOutcome {
  intents: RuleIntent[];
  /** The rules could not settle this comment; stage 2 should look at it. */
  needsLlm: boolean;
  /** Ceiling on any LLM answer for this comment, so the seller confirms whatever the LLM reads into it. */
  llmCap?: number;
  /** Why llmCap is set. */
  capReason?: string;
}

/** Below the grant threshold: the seller reviews it. */
export const REVIEW_CAP = 0.75;

type Role =
  | { r: "code"; code: string; marked: boolean }
  | { r: "num"; n: string }
  | { r: "size"; candidates: string[]; raw: string }
  | { r: "color"; words: string[] }
  | { r: "qty"; qty: number }
  | { r: "price" }
  | { r: "grade" }
  | { r: "rating" }
  | { r: "neg" }
  | { r: "corr" }
  | { r: "or" }
  | { r: "marker" }
  | { r: "filler" }
  | { r: "title"; code: string }
  | { r: "word" }
  | { r: "skip" };

export interface Ref {
  code?: string;
  byTitle?: boolean;
  sizes: { candidates: string[]; raw: string }[];
  colors: string[][];
  qty?: number;
}

const words = (s: string) => new Set(s.split(" "));

const FILLER = words(
  "please pls plz plss plzz pleas pleasee pl thanks thank you u ty tysm thx thnx mam maam ma'am madam didi di dii " +
    "bhaiya bhai bhaiyya sis sister girl girlie hun hon babe ji jii ok okay k yes yess yay yep yup oh ooh omg wow " +
    "the a an in of for my i i'm im and size sz siz color colour one wala vala wali wale vali ka ki ke kar kr " +
    "de dijiye dijie karo krdo kardo hai h liye ho na ne se ko mein pe par also too plus qty quantity pc pcs piece pieces lo el la talla en y por " +
    "favor porfa pf hey hi hello hii hiii ya yeah it that this them those both ye yeh bhi wo woh vo to " +
    "mom mum mama mother daughter sister hermana mami hija friend bestie wife husband hubby para mi",
);
const CUE_WORDS = words(
  "want wants need needs take get have grab book i'll ill can could may will lemme let gonna rakh rakhdo rakhna " +
    "lena leni mera meri mere mujhe yo add done dedo de do dena dijiye kar kr krdo kardo karo karwa jaf quiero apartas aparta",
);
const QSTART = words(
  "is are does do did can could will would what whats what's how which where when who any anyone anybody hay tienes tiene cual cuál kya kitne kitna kitni kaise kese kab kaun kahan kon should",
);
const QSTRONG =
  /\b(how much|price|prize|pp|cost|kitne|kitna|kitni|kya|kia|milega|milegi|mil jayega|cuanto|cuánto|cuesta|precio|sold out|in stock|available|availble|avail|avl|tts|true to size|measurements?|what size|which size|any left|still have|qu[eé] (talla|tallas|precio|color|colores|tamaño)|what (number|item|lot|size|colou?r|price)|shipping|delivery|cod|kahan|kaha|kaise|kab|konsa|kaunsa|kaun sa)\b|^(sizes?|price|rate|colou?rs?)$/;
/** Hindi idioms that contain a question word but ask nothing ("kya baat hai" = how lovely; "done kiya" = did it). */
const NOT_A_QUESTION = /\bkya baat\b|\b(kar|kr|done|book|order|share|like|liya|le) (kia|kiya|kya)\b/g;
const WAITLIST =
  /\b(wait ?list(ed)?|wl|w\/l|back ?up|next in line|lista de espera)\b|\bif (it|that|one|anyone|any1|someone|somebody|they|she|he|the \w+) (falls?|cancels?|backs?|doesn'?t|don'?t|does not|do not|passes|changes)|\bfalls? through\b|\bkoi (nahi|nhi|na|nai) (lega|legi|le|leta)\b|\bagar koi\b|\bsi alguien\b|\b(koi|agar) (cancel|chod|chhod|chhor)\w*|\bcancel (kare|kre|karega|karti|karta|ho|hua|hojaye|ho jaye) (to|toh)\b|\bwaiting (me|mein|mai|list)\b|\bwaiting$/;
const CANCEL =
  /\b(cancel+e?d?|cancle|canel|cxl|cncl|cancela|cancelar|cancelo|unclaim|retract|nvm|nevermind|never mind|jk|j\/k|just kidding|just playing)\b|\b(remove|take) me (off|from|out)\b|\bno longer\b|\bchanged my mind\b|\b(don'?t|dont|do not) want\b|\b(nahi|nhi|na|nai|mat) (chahiye|chaiye|chahie|chaye|chahiyea|chiye|lena|leni|lungi|bhejo|bhejna)\b|\brehne do\b|\bno lo quiero\b|\bya no\b|\bdrop (my|me)\b/;
const EXPLICIT_CANCEL = /\b(cancel+e?d?|cancle|cxl|cancela|cancelar|unclaim|retract)\b/;
const CHANGE =
  /\b(change|chnage|chng|switch|swap|exchange|instead|cambia|cambiar|cambio|badal|badlo|badaldo)\b|\bki jagah\b|\bke badle\b|\ben vez\b|\bmake (it|mine|that|this|my \w+)\b|\bc[aá]mbi\w*|\bmejor (el|la|en)\b|^\*/;
const POLITE_CLAIM = /\b(can|could|may) i (get|have|claim|take|grab|do)\b|\b(i'?ll|ill|i will|i'?d|id|lemme|let me|gonna) (take|get|have|grab|do)\b/;
const HYPOTHETICAL = /\b(wish|if only|can'?t|cannot|couldn'?t|wanted to|would have|would've|broke|afford|everything|every single|all of (them|it|these|those)|all the \w+s)\b/;
/** The viewer means an earlier item without naming it; the on-screen item is the wrong guess. */
const BACK_REF = /\b(from (earlier|before)|earlier one|the one before|de antes|previous|last one|pehle (wala|wali|vala|vali|wla)|pichla|pichhla)\b/;
const HINGLISH = words(
  "hai h hain kya kia nhi nahi ka ki ke ko ji didi mam maam wala vala wali krdo kardo kr karo dijiye chahiye chaiye mera meri mujhe bhi aap apka sab hogaya",
);
const SOLD_FORMS = words("sold soldd solds sodl slod sould soled sokd solde siold sols s0ld");
const NOT_SOLD_BEFORE = words("is it its it's already all everything sab are was were been get got i we you they he she also just item mine almost");
// "sold aa raha hai", "sold ho gaya": Hindi auxiliaries after "sold" describe stock, not a claim.
const NOT_SOLD_AFTER = words("out h hai hain hogaya hogya hogye ho kya already mine my on to aa raha rha rahi rhi gaya gayi chuka chuki hua");
const CLAIM_WORDS = words("claim claiming clam dibs gimme buy buying purchase quiero mio mío mia mía apartas apartame aparta apartar apartado dame damelo dámelo lungi lunga leti mine");
const ME_BLOCK_BEFORE = words("show send tell let text dm message call ping help to with email msg remind teach ask pm contact skipped missed forgot saw see hear heard remove take tag");
const ME_BLOCK_AFTER = words("know a the pic pics picture video how what when where more neither either");
const ME_OK_BEFORE = words("give gimme add pick and oh ooh omg ok yes yess also");
const BOOK_NEXT_OK = words("kar kr krdo kardo karo karwa karwado krwa krwado karna dijiye dijie do jaf karde krde krdijiye kardijiye please pls plz it this me for");
const BOOK_PAST = words("liya liye liyaa diya kiya kia kiye karwaye hogaya hogya hua ho nahi nhi kaise kese krne karne");
const CHAHIYE = words("chahiye chaiye chahie chaye chahiyea chiye chahiya");
const CORRECTION = words("wait mean meant sorry oops actually correction sry");
const NEGATION = words("not no nahi nhi nope nah");
const CODE_MARKERS = words("# num number item itm lot style code no nr design");
const PRICE_BEFORE = words("$ ₹ rs inr usd");
const PRICE_AFTER = words("$ rs bucks buck dollars dollar rupees rupee usd inr");
const QTY_AFTER = words("pcs pc piece pieces units unit sets set of");
const HINDI_NEG = words("nahi nhi nahin");
const SEPARATORS = words("and & , + y aur plus also");
const QTY_BEFORE = words("make it get take want need qty quantity");
const QTY_NEXT = words("please pls plz units more");

// Speaker attribution: the cue is there, but it is not this viewer claiming this item now.
const NEG_BEFORE_CUE = words("not no nahi nope nah never don't dont didn't didnt doesn't doesnt won't wont isn't isnt can't cant aren't");
/** Third-person verb forms: someone else wants it ("Ric wants it"). */
const THIRD_PERSON_VERBS = words("wants needs claims takes gets buys grabs likes loves books");
const THIRD_SUBJECTS = words("he she they someone somebody everyone everybody anyone anybody nobody you u ur your his her their them him yall y'all");
const PROXY_SUBJECTS = words("mom mum mama mother daughter sister sis friend bestie wife husband hubby son brother aunt cousin");
const HINDI_THIRD = words("usko unko inko unhe inhe usne unhone inhone uske unke");
const SUBJECT_ADVERBS = words("really also just still def definitely totally would will 'll prob probably");
const PAST_REPORT = words("claimed bought booked took got grabbed purchased ordered paid won snagged");
/** Words that make a past-tense comment about claiming rather than about anything else. */
const CLAIM_STEMS = words("claim claimed sold book booked booking order ordered bought buy purchased got took grabbed snagged won liya");
/** Hindi perfective forms ("maine ... kiya", "de di", "mil gaya"): something already happened. */
const HINDI_PAST = /\bmaine\b|\b(ho gaya|ho gayi|kar diya|kar di|de diya|de di|le liya|le li|mil gaya|mil gayi|kiya|liya|diya|mila|mili|daali|dali|bheja|bheji|karwa liya|karaya|karayi|karai)\b|\b(tha|thi)$/;
/** Cue verbs that take an object; the object must be an item, not "the channel" or "claim line". */
const OBJECT_VERBS = words("claim take want need buy get grab have book");
const HINDI_OBJECT_VERBS = words("book chahiye rakh de bhej");
const OBJECT_SKIP = words("the a an that this my one it them both these those please pls plz for me mujhe mera meri mere bhi ye yeh ji di didi mam");
/** "how do I book", "kaise book kare": asks how to claim, which is a question. */
const HOW_WORDS = words("how where which when kaise kahan kis kab kaunsa kaun");
const DISPLAY_WORDS = words("show dikhao zoom");
const DEICTIC = words("ye yeh yah yahi yehi ise isko iska iski isme this that it wala wali wale vala vali");
const GRADE_RE = /^\d{1,2}\.\d{1,2}$/;
const LETTER_CUES = new Set([...CLAIM_WORDS, ...words("want take book slot me")]);
/** Words that point at an item by position rather than naming it ("the last suit", "pichla wala"). */
const POSITION = /\b(last|previous|prev|earlier|before|next|pichla|pichli|pichle|pichhla|pichhli|pehle|pehla|pehli|pahle|pahla|agla|agli|agle|dusra|dusri|dusre|doosra|other one|the other)\b|\bon the (left|right)\b/;
/** Every code is a single letter: a lettered grid ("claim C"). */
const isLettered = (codes: Iterable<string>) => {
  const all = [...codes];
  return all.length >= 2 && all.every((c) => /^[a-z]$/i.test(c));
};
/** Common live-chat English: a short comment made only of these needs no LLM to be read as chatter. */
const COMMON_CHAT = words(
  "lol lmao haha hahaha omg wow love loved lovely cute nice beautiful gorgeous pretty stunning amazing awesome great good cool " +
    "hi hello hey hii morning evening night afternoon everyone everybody all guys yall welcome thanks thank ty congrats congratulations " +
    "yes no yeah nope ok okay sure same agree true right lucky so very too much many really is are was were be been am " +
    "we you they he she it its it's that's this that what why who when where how here there now later soon today tonight tomorrow " +
    "back again bye see watch watching live show stream fun happy birthday bday name hope win won lost miss missed late early first " +
    "got get go going gone come coming came do did done not just like with from on at by to up out over about have has had " +
    "can will would should could need want fire lit gg rip smh idk tbh ikr fr bro sis babe dear friend friends nice nicee",
);
const FIRST_PERSON_HI = /\b(mujhe|mera|meri|mere|hume|hamara|hamari)\b/;
const REQUEST_HI = /\b(kar|de|rakh|bhej|pack|book) (do|dena|dijiye|de|lo|lijiye)\b|\b(book|pack) (karo|kare|karna|karni)\b/;

function editDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export const isSoldForm = (w: string) => SOLD_FORMS.has(w) || (w.length >= 4 && w.length <= 5 && w[0] === "s" && editDistance1(w, "sold"));

function colorFits(item: ShowItem | undefined, wordsList: string[][]): boolean {
  if (!item) return false;
  const aliases = colorAliases(item);
  return wordsList.some((ws) => aliases.has(ws.join(" ")) || ws.some((w) => aliases.has(canonColor(w))));
}

const TITLE_STOP = words("the and for with new one two all our you out see her his its are was off top set lot item mini");
const singular = (w: string) =>
  w.length > 4 && /(ch|sh|x|s)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/** Distinctive title words (unique to one item, singularised) -> item code. */
function titleIndex(items: Iterable<ShowItem>): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const item of items) {
    for (const raw of item.title.toLowerCase().split(/[^a-z0-9À-ɏ]+/)) {
      const w = singular(raw);
      if (w.length < 3 || TITLE_STOP.has(w) || FILLER.has(w) || SIZE_WORDS[w] || COLOR_WORDS.has(w) || /\d/.test(w)) continue;
      if (!seen.has(w)) seen.set(w, new Set());
      seen.get(w)!.add(item.code);
    }
  }
  const out = new Map<string, string>();
  for (const [w, codes] of seen) if (codes.size === 1) out.set(w, [...codes][0]!);
  return out;
}

export interface Parsed {
  text: string;
  tokens: Token[];
  roles: Role[];
  refs: Ref[];
  /** Codes ruled out by "not 7" (neg) or replaced by "7 no wait 8" (corr). */
  negated: { code: string; how: "neg" | "corr" }[];
  unknownNums: string[];
  ambiguousCodeSize: boolean;
  orBetweenCodes: boolean;
  hinglish: boolean;
  qmark: boolean;
  question: boolean;
  claimStrong: boolean;
  claimWeak: boolean;
  soldCue: boolean;
  claimTypo: boolean;
  hypothetical: boolean;
  /** "the one from earlier": an unnamed earlier item. */
  backRef: boolean;
  /** "28 not 26": a size or colour was ruled out in favour of another. */
  variantNegated: boolean;
  cancel: boolean;
  change: boolean;
  waitlist: boolean;
  chatter: string[];
  emojiOnly: boolean;
  /** Written partly in Hindi (Devanagari or romanised). */
  hindi: boolean;
  /** Decimal grades after a claim ("claim 9.6"): a description of the on-screen item, not a code. */
  grades: number;
  /** Set when the claim cue is not this viewer claiming now: negated, someone else's, a past report, or aimed at a non-item. */
  notSpeaker?: string;
  /** A cue verb takes an object that is not an item ("claim the channel"). */
  objectUnknown: boolean;
  /** Asks how/where to claim ("how do I book", "kaise book kare"). */
  howTo: boolean;
  /** Points at something without naming it: ye/this/it/wala. */
  deictic: boolean;
  /** A short comment with a word no vocabulary here knows (a card name, a typo, another language). */
  unknownShort: boolean;
  /** Numbers read as prices, quantities or grades. */
  otherNums: number;
  /** Any claim word at all, strong or weak, before hypotheticals are discounted. */
  cue: boolean;
}

/** Token-level parse of one comment against the show context. Pure and synchronous. */
export function parse(raw: string, ctx: ResolverContext): Parsed {
  const norm = normalize(raw);
  const { text, hasQuestionMark, emojiOnly } = norm;
  const items = new Map(ctx.items.map((i) => [i.code.toLowerCase(), i]));
  if (ctx.currentItem) items.set(ctx.currentItem.code.toLowerCase(), ctx.currentItem);
  const current = ctx.currentItem;

  // Spelled-out numbers behave like digits ("seven", "two of"); "one" only after a marker ("number one").
  const tokens: Token[] = norm.tokens.map((t, i) => {
    const n = NUMBER_WORDS[t.t];
    if (n === undefined || (t.t === "one" && !CODE_MARKERS.has(norm.tokens[i - 1]?.t ?? ""))) return t;
    return { ...t, t: String(n), kind: "num", spelled: true } as Token;
  });
  const at = (i: number) => tokens[i]?.t;
  const hinglish = norm.hindi || tokens.some((t) => HINGLISH.has(t.t));
  const upperM = /(^|[^A-Za-z])M([^A-Za-z]|$)/.test(raw);
  const colorVocab = new Set<string>([...COLOR_WORDS, ...Object.keys(COLOR_SYNONYMS)]);
  const colorBigrams = new Set<string>();
  for (const item of items.values()) {
    for (const alias of colorAliases(item).keys()) (alias.includes(" ") ? colorBigrams : colorVocab).add(alias);
  }
  const roles: Role[] = tokens.map(() => ({ r: "word" }));
  const lettered = isLettered(items.keys());
  // A slot letter ("claim c", "claim c and d") is a code only right after a claim word or another slot
  // letter; "a" and "i" also need nothing after them, since they are usually English words.
  const letterCode = (i: number): boolean => {
    const w = at(i)!;
    if (!lettered || tokens[i]!.kind !== "word" || !/^[a-z]$/.test(w) || !items.has(w)) return false;
    const next = tokens[i + 1];
    if ((w === "a" || w === "i") && next && next.kind !== "punct" && !SEPARATORS.has(next.t) && !FILLER.has(next.t) && !/^[a-z]$/.test(next.t)) return false;
    for (let j = i - 1; j >= 0; j--) {
      if (tokens[j]!.kind === "punct" || SEPARATORS.has(at(j)!)) continue;
      return roles[j]!.r === "code" || isSoldForm(at(j)!) || LETTER_CUES.has(at(j)!);
    }
    return false;
  };

  // Pass 1: prices, ratings, quantities, explicit sizes, colours, markers.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const w = tok.t;
    if (roles[i]!.r !== "word") continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    if (letterCode(i)) {
      roles[i] = { r: "code", code: items.get(w)!.code, marked: false };
      continue;
    }
    if (tok.kind === "num") {
      const knownDecimal = w.includes(".") && [...items.values()].some((it) => it.code === w || sizesOf(it).includes(w));
      const handle = prev && tokens[i - 1]!.kind === "word" && glued(tokens[i - 1], tok) && prev.length >= 3 && !isSoldForm(prev) && !CODE_MARKERS.has(prev) && !CUE_WORDS.has(prev) && !CLAIM_WORDS.has(prev) && !SIZE_WORDS[prev] && prev !== "size";
      if (handle) {
        roles[i] = { r: "skip" }; // "calilady525": digits inside a username, not a number
      } else if (w.includes(".") && !knownDecimal) {
        roles[i] = GRADE_RE.test(w) && Number(w) <= 10 ? { r: "grade" } : { r: "price" };
      } else if ((prev && PRICE_BEFORE.has(prev)) || (next && PRICE_AFTER.has(next))) {
        roles[i] = { r: "price" };
      } else if (next === "/" && tokens[i + 2]?.kind === "num" && glued(tok, tokens[i + 1]) && glued(tokens[i + 1], tokens[i + 2]) && [5, 10].includes(Number(at(i + 2))) && Number(w) <= Number(at(i + 2))) {
        roles[i] = roles[i + 1] = roles[i + 2] = { r: "rating" };
      } else if (prev === "x" || prev === "*") {
        roles[i - 1] = { r: "skip" };
        roles[i] = { r: "qty", qty: Number(w) };
      } else if (prev === "qty" || prev === "quantity" || (next && QTY_AFTER.has(next))) {
        roles[i] = { r: "qty", qty: Number(w) };
      } else if (prev === "size" || prev === "sz" || prev === "siz" || prev === "talla" || (next === "size" && tokens[i + 2]?.kind !== "num")) {
        roles[i] = { r: "size", candidates: [w], raw: w };
      } else if (next === "t" && glued(tok, tokens[i + 1])) {
        roles[i] = { r: "size", candidates: [`${w}T`], raw: `${w}t` };
        roles[i + 1] = { r: "skip" };
      } else if ((next === "xl" || next === "x") && glued(tok, tokens[i + 1]) && !(tokens[i + 2]?.kind === "num" && glued(tokens[i + 1], tokens[i + 2]))) {
        const key = `${w}${next}`;
        roles[i] = { r: "size", candidates: SIZE_WORDS[key] ?? [key.toUpperCase()], raw: key };
        roles[i + 1] = { r: "skip" };
      } else if (prev === "w" && glued(tokens[i - 1], tok)) {
        roles[i - 1] = { r: "skip" };
        roles[i] = { r: "size", candidates: [`W${w}`], raw: `w${w}` };
      } else {
        if (prev && CODE_MARKERS.has(prev) && (prev !== "no" || text[tokens[i - 1]!.end] === ".")) roles[i - 1] = { r: "marker" };
        roles[i] = { r: "num", n: w };
      }
      continue;
    }
    const bigram = `${w} ${next ?? ""}`;
    if (colorBigrams.has(bigram)) {
      roles[i] = { r: "color", words: [w, next!] };
      roles[i + 1] = { r: "skip" };
    } else if (SIZE_BIGRAMS[bigram]) {
      roles[i] = { r: "size", candidates: SIZE_BIGRAMS[bigram]!, raw: bigram };
      roles[i + 1] = { r: "skip" };
    } else if (next === "/" && SIZE_WORDS[w] && at(i + 2) && SIZE_WORDS[at(i + 2)!]) {
      const combo = `${w}/${at(i + 2)}`.toUpperCase();
      roles[i] = { r: "size", candidates: [combo, ...SIZE_WORDS[w]!], raw: combo.toLowerCase() };
      roles[i + 1] = roles[i + 2] = { r: "skip" };
    } else if (SIZE_WORDS[w] && !(w === "m" && hinglish && !upperM && next !== "size" && prev !== "size")) {
      roles[i] = { r: "size", candidates: SIZE_WORDS[w]!, raw: w };
    } else if (colorVocab.has(canonColor(w))) {
      roles[i] = { r: "color", words: [w] };
    } else if (w === "or" || w === "o" || (w === "/" && tokens[i - 1]?.kind === "num" && tokens[i + 1]?.kind === "num")) {
      roles[i] = { r: "or" };
    } else if (NEGATION.has(w)) {
      roles[i] = CORRECTION.has(next ?? "") ? { r: "corr" } : { r: "neg" };
    } else if (CORRECTION.has(w)) {
      roles[i] = { r: "corr" };
    } else if (FILLER.has(w)) {
      roles[i] = { r: "filler" };
    }
  }

  // Distinctive title words ("the romper", "bows x3"): they name an item and set the size target.
  const index = titleIndex(items.values());
  const titleAt = new Map<number, string>();
  tokens.forEach((t, i) => {
    const code = roles[i]!.r === "word" && t.kind === "word" ? index.get(singular(t.t.replace(/'s$/, ""))) : undefined;
    if (code) titleAt.set(i, code);
  });
  const titleCodes = new Set(titleAt.values());
  if (titleCodes.size > 2) titleAt.clear();
  const titleItem = titleCodes.size === 1 ? items.get([...titleCodes][0]!.toLowerCase()) : undefined;

  // Pass 2: each number becomes a code, a size of the item in play, a quantity, a price, or an unknown.
  const colorsInComment = roles.flatMap((r) => (r.r === "color" ? [r.words] : []));
  const numCount = roles.filter((r) => r.r === "num").length;
  const hasLetterSize = roles.some((r) => r.r === "size" && !/^\d/.test(r.raw));
  const maxCode = Math.max(0, ...[...items.keys()].map(Number).filter(Number.isFinite));
  const negated: Parsed["negated"] = [];
  const unknownNums: string[] = [];
  // Hindi negates what comes before it ("1 nahi 3"); that "nahi" must not also negate what follows.
  const postNegation = (j: number) => HINDI_NEG.has(at(j) ?? "") && ["code", "size", "color", "num"].includes(roles[j - 1]?.r ?? "");
  let ambiguousCodeSize = false;
  let orBetweenCodes = false;
  let lastCode: string | undefined;
  let sawOr = false;

  for (let i = 0; i < tokens.length; i++) {
    const role = roles[i]!;
    if (role.r === "or" && lastCode) sawOr = true;
    if (role.r !== "num") continue;
    const n = role.n;
    const marked = roles[i - 1]?.r === "marker";
    const prefersCode = marked || at(i - 1) === "my" || (sawOr && !!lastCode) || (!lastCode && n === current?.code && !titleItem) || hasLetterSize;
    const asCode = items.get(n.toLowerCase());
    const target = lastCode ? items.get(lastCode.toLowerCase()) : (titleItem ?? current);
    const asSize = target ? matchSize(target, [n]) : undefined;
    let code: string | undefined;
    if (asCode && (!asSize || prefersCode)) code = asCode.code;
    else if (asCode && asSize && (lastCode || titleItem)) roles[i] = { r: "size", candidates: [asSize], raw: n };
    else if (asCode && asSize) {
      const fitsCurrent = numCount === 1 && colorFits(current, colorsInComment);
      const fitsCode = numCount === 1 && colorFits(asCode, colorsInComment);
      if (fitsCurrent && !fitsCode) roles[i] = { r: "size", candidates: [asSize], raw: n };
      else {
        if (!(fitsCode && !fitsCurrent)) ambiguousCodeSize = true;
        code = asCode.code;
      }
    } else if (asSize) roles[i] = { r: "size", candidates: [asSize], raw: n };
    else if (Number(n) <= 5 && current && !lastCode && ((tokens[i] as Token & { spelled?: boolean }).spelled || QTY_BEFORE.has(at(i - 1) ?? "") || QTY_NEXT.has(at(i + 1) ?? ""))) {
      roles[i] = { r: "qty", qty: Number(n) };
    } else if (n.length >= 3 && Number(n) > 10 * Math.max(maxCode, 1)) roles[i] = { r: "price" };
    else unknownNums.push(n);
    if (!code) continue;
    roles[i] = { r: "code", code, marked };
    const negIdx = [i - 1, i - 2].find((j) => roles[j]?.r === "neg" && !postNegation(j));
    const hindiNeg = HINDI_NEG.has(at(i + 1) ?? "") && roles.slice(i + 2).some((r) => r.r === "num");
    if (hindiNeg || (negIdx !== undefined && !roles.slice(negIdx + 1, i).some((r) => r.r === "code"))) {
      negated.push({ code, how: "neg" });
      continue;
    }
    if (sawOr) orBetweenCodes = true;
    lastCode = code;
    sawOr = false;
  }

  // "12 no wait 13", "12 sorry 13": the code before the correction is replaced.
  for (let i = 0; i < roles.length; i++) {
    if (roles[i]!.r !== "corr") continue;
    const before = roles.slice(0, i).findLastIndex((r) => r.r === "code");
    if (before >= 0 && roles.slice(i + 1).some((r) => r.r === "code")) {
      negated.push({ code: (roles[before] as { code: string }).code, how: "corr" });
      roles[before] = { r: "skip" };
    }
  }

  // "28 not 26", "M nahi L": a ruled-out size or colour is dropped and the comment becomes a variant swap.
  let variantNegated = false;
  roles.forEach((r, i) => {
    if (r.r !== "size" && r.r !== "color") return;
    const ruledOut = (roles[i - 1]?.r === "neg" && !postNegation(i - 1)) || HINDI_NEG.has(at(i + 1) ?? "");
    if (ruledOut && roles.some((o, j) => j !== i && o.r === r.r)) {
      roles[i] = { r: "skip" };
      variantNegated = true;
    }
  });

  const isNegated = (code: string) => negated.some((n) => n.code === code);
  const numericCodes = new Set(roles.flatMap((r) => (r.r === "code" && !isNegated(r.code) ? [r.code] : [])));
  for (const [i, code] of titleAt) if (roles[i]!.r === "word" && !numericCodes.has(code)) roles[i] = { r: "title", code };

  // Attributes attach to the latest item named; "and"/","/"aur" between two sizes starts a second claim.
  const refs: Ref[] = [];
  const hasAttrs = (r: Ref) => r.sizes.length > 0 || r.colors.length > 0 || r.qty !== undefined;
  let pending: Ref = { sizes: [], colors: [] };
  let sep = false;
  roles.forEach((role, i) => {
    if (SEPARATORS.has(at(i) ?? "")) sep = true;
    if (role.r === "code" || role.r === "title") {
      if (role.r === "code" && isNegated(role.code) && !refs.some((r) => r.code === role.code)) return;
      if (role.r === "title" && refs.some((r) => r.code === role.code)) return;
      const ref: Ref = { code: role.code, sizes: [], colors: [], ...(role.r === "title" && { byTitle: true }) };
      if (refs.length === 0 && hasAttrs(pending)) {
        if (sep && current && current.code !== role.code) refs.push({ ...pending, code: current.code });
        else Object.assign(ref, { sizes: pending.sizes, colors: pending.colors, qty: pending.qty });
        pending = { sizes: [], colors: [] };
      }
      refs.push(ref);
      sep = false;
    } else if (role.r === "size" || role.r === "color" || role.r === "qty") {
      let into = refs.length ? refs[refs.length - 1]! : pending;
      const clash = (role.r === "size" && into.sizes.length > 0) || (role.r === "color" && into.colors.length > 0);
      if (clash && sep && into === pending && current) {
        pending.code = current.code;
        refs.push(pending);
      }
      if (clash && sep && into.code) {
        into = { code: into.code, sizes: [], colors: [], ...(into.byTitle && { byTitle: true }) };
        refs.push(into);
      }
      if (role.r === "size") into.sizes.push({ candidates: role.candidates, raw: role.raw });
      else if (role.r === "color") into.colors.push(role.words);
      else into.qty = role.qty;
      sep = false;
    }
  });
  if (refs.length === 0 && (pending.sizes.length || pending.colors.length || pending.qty !== undefined)) refs.push(pending);

  // Cues.
  let claimStrong = POLITE_CLAIM.test(text);
  let claimWeak = false;
  let soldCue = false;
  let claimTypo = false;
  const cues: number[] = [];
  const contentIdx = tokens.map((t, i) => (t.kind !== "punct" && roles[i]!.r !== "skip" ? i : -1)).filter((i) => i >= 0);
  const hasRefNear = (i: number) => [i + 1, i + 2, i - 1].some((j) => ["code", "size", "color", "qty", "title"].includes(roles[j]?.r ?? ""));
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!.t;
    const prev = at(i - 1);
    const next = at(i + 1);
    if (isSoldForm(w) || (w === "sol" && tokens[i + 1]?.kind === "num")) {
      const lastContent = !contentIdx.some((j) => j > i && roles[j]!.r !== "filler");
      const blocked = (prev && NOT_SOLD_BEFORE.has(prev)) || (next && NOT_SOLD_AFTER.has(next)) || (hasQuestionMark && lastContent);
      if (!blocked) {
        claimStrong = soldCue = true;
        cues.push(i);
        if (!SOLD_FORMS.has(w)) claimTypo = true;
      }
    } else if (CLAIM_WORDS.has(w)) {
      if (w === "mine" && next && ["is", "are", "was", "were", "came", "arrived", "last", "broke", "got"].includes(next)) continue;
      if (prev === "to") continue; // "to buy in", "hard to claim": not a claim by itself
      claimStrong = true;
      cues.push(i);
    } else if (w === "me") {
      if (hinglish && contentIdx.length > 2) continue;
      if ((next && ME_BLOCK_AFTER.has(next) && !hasRefNear(i)) || (prev && ME_BLOCK_BEFORE.has(prev))) continue;
      const forMe = prev === "for" && roles.some((r) => ["code", "size", "color", "title"].includes(r.r)); // "M blue for me"
      if (contentIdx[0] === i || contentIdx.length <= 3 || (prev && ME_OK_BEFORE.has(prev)) || hasRefNear(i) || forMe) {
        claimStrong = true;
        cues.push(i);
      }
    } else if (w === "want" || w === "wants" || w === "need" || w === "needs") {
      if (next === "to" || /\b(do|does|did) (you|anyone|u)\b|\bwho\b/.test(text)) continue;
      claimStrong = true;
      cues.push(i);
    } else if (w === "take") {
      if (next === "me" || next === "a" || prev === "to") continue;
      if ((prev && ["i'll", "ill", "i", "will", "gonna", "can", "could", "i'd"].includes(prev)) || hasRefNear(i) || ["it", "that", "this", "the", "one", "both"].includes(next ?? "")) {
        claimStrong = true;
        cues.push(i);
      }
    } else if (w === "book") {
      if ((next && BOOK_PAST.has(next)) || (at(i + 2) && BOOK_PAST.has(at(i + 2)!)) || prev === "to") continue;
      if (!next || BOOK_NEXT_OK.has(next) || hasRefNear(i)) {
        claimStrong = true;
        cues.push(i);
      }
    } else if (CHAHIYE.has(w)) {
      if ((prev && NEGATION.has(prev)) || /\b(kya|kisko|jo|kisi)\b/.test(text)) continue;
      claimStrong = true;
      cues.push(i);
    } else if (w === "rakh" || w === "rakhna" || w === "rakhdo") {
      claimStrong = true;
      cues.push(i);
    } else if (w === "lena" || w === "leni") {
      if (next === "hai" || next === "h" || next === "he") {
        claimStrong = true;
        cues.push(i);
      }
    } else if (["mera", "meri", "mere", "mujhe", "yo", "add", "done", "dedo", "de"].includes(w)) {
      if (w === "done" && (prev === "like" || prev === "share" || next === "kia" || next === "kiya")) continue;
      if (w === "de" && !["do", "dena", "dijiye"].includes(next ?? "")) continue;
      if (next === "bhi" && w !== "de" && w !== "done" && contentIdx.length <= 3) {
        claimStrong = true; // "mujhe bhi" = me too
        cues.push(i);
      } else if (hasRefNear(i) || ["book", "rakh", "de", "dedo", "le"].includes(next ?? "") || contentIdx.length <= 2) {
        claimWeak = true;
        cues.push(i);
      }
    }
  }
  // "ye mere liye kar do", "mera bhi book karo": a first-person request in Hindi word order.
  const display = tokens.some((t) => DISPLAY_WORDS.has(t.t));
  if (!display && FIRST_PERSON_HI.test(text) && (REQUEST_HI.test(text) || /\bmere liye\b/.test(text))) {
    claimStrong = true;
    const at0 = tokens.findIndex((t) => FIRST_PERSON_HI.test(t.t));
    if (at0 >= 0 && !cues.includes(at0)) cues.push(at0);
  }
  cues.sort((a, b) => a - b);
  const cue = cues.length > 0 || claimStrong || claimWeak;

  const isContentWord = (i: number) => roles[i]?.r === "word" && tokens[i]?.kind === "word";
  const pastReport = tokens.some((t) => PAST_REPORT.has(t.t)) || (hinglish && HINDI_PAST.test(text));
  const notSpeaker = (() => {
    if (!cues.length) return pastReport && tokens.some((t) => CLAIM_STEMS.has(t.t)) ? "past report" : undefined;
    const negatedCue = (i: number) =>
      NEG_BEFORE_CUE.has(at(i - 1) ?? "") || (["for", "to"].includes(at(i - 1) ?? "") && NEG_BEFORE_CUE.has(at(i - 2) ?? "")) || HINDI_NEG.has(at(i + 1) ?? "");
    if (cues.every(negatedCue)) return "negated";
    const subjectOf = (i: number) => {
      let j = i - 1;
      while (j >= 0 && SUBJECT_ADVERBS.has(at(j)!)) j--;
      return at(j);
    };
    const thirdPerson = (i: number) => {
      const w = at(i)!;
      if (THIRD_PERSON_VERBS.has(w)) return true;
      const subj = subjectOf(i);
      if (OBJECT_VERBS.has(w) && subj && (THIRD_SUBJECTS.has(subj) || PROXY_SUBJECTS.has(subj))) return true;
      return hinglish && tokens.slice(0, i).some((t) => HINDI_THIRD.has(t.t) || (t.t === "use" && CHAHIYE.has(w)));
    };
    if (cues.every(thirdPerson)) return "someone else's";
    if (pastReport) return "past report";
    return undefined;
  })();

  const objectOf = (i: number) => {
    const w = at(i)!;
    const step = OBJECT_VERBS.has(w) ? 1 : HINDI_OBJECT_VERBS.has(w) ? -1 : 0;
    if (!step) return undefined;
    for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
      if (tokens[j]!.kind === "punct" || roles[j]!.r === "skip") continue;
      if (OBJECT_SKIP.has(at(j)!) || CUE_WORDS.has(at(j)!) || CLAIM_WORDS.has(at(j)!)) continue;
      return j;
    }
    return undefined;
  };
  const objectUnknown =
    refsEmpty(roles) &&
    cues.some((i) => {
      const j = objectOf(i);
      return j !== undefined && isContentWord(j) && !FILLER.has(at(j)!) && !DEICTIC.has(at(j)!);
    });
  const firstHow = tokens.findIndex((t) => HOW_WORDS.has(t.t));
  const howTo = firstHow >= 0 && cues.length > 0 && firstHow < cues[0]! && !soldCue;
  const known = (w: string) => FILLER.has(w) || CUE_WORDS.has(w) || CLAIM_WORDS.has(w) || QSTART.has(w) || COMMON_CHAT.has(w) || HINGLISH.has(w) || NEGATION.has(w) || isSoldForm(w) || w === "me";
  const unknownShort = contentIdx.length <= 3 && tokens.some((t, i) => isContentWord(i) && !known(t.t));
  const hypothetical = HYPOTHETICAL.test(text);
  if (hypothetical && !(soldCue && roles.some((r) => r.r === "code"))) claimStrong = false;

  const firstContent = contentIdx.length ? at(contentIdx[0]!) : undefined;
  const asked = text.replace(NOT_A_QUESTION, " ");
  const qWordFirst = !!firstContent && QSTART.has(firstContent) && contentIdx.length >= 3 && asked.trimStart().startsWith(firstContent);
  const question = hasQuestionMark || (qWordFirst && !POLITE_CLAIM.test(text)) || QSTRONG.test(asked);
  const chatter = tokens
    .filter((t, i) => roles[i]!.r === "word" && t.kind === "word" && !isSoldForm(t.t) && !CLAIM_WORDS.has(t.t) && !CUE_WORDS.has(t.t) && !CHAHIYE.has(t.t) && t.t !== "me")
    .map((t) => t.t);

  return {
    text,
    tokens,
    roles,
    refs,
    negated,
    unknownNums,
    ambiguousCodeSize,
    orBetweenCodes,
    hinglish,
    qmark: hasQuestionMark,
    question,
    claimStrong,
    claimWeak,
    soldCue,
    claimTypo,
    hypothetical,
    backRef: BACK_REF.test(text),
    variantNegated,
    cancel: CANCEL.test(text),
    change: CHANGE.test(text),
    waitlist: WAITLIST.test(text),
    chatter,
    emojiOnly,
    hindi: norm.hindi,
    grades: roles.filter((r) => r.r === "grade").length,
    notSpeaker,
    objectUnknown,
    howTo,
    deictic: tokens.some((t) => DEICTIC.has(t.t)),
    unknownShort,
    otherNums: roles.filter((r) => r.r === "price" || r.r === "qty" || r.r === "grade").length,
    cue,
  };
}

const refsEmpty = (roles: Role[]) => !roles.some((r) => r.r === "code" || r.r === "title" || r.r === "size" || r.r === "color");

interface Resolved {
  code?: string;
  byTitle?: boolean;
  size?: string;
  color?: string;
  qty?: number;
  unavailable: boolean;
  fit: "exact" | "underspecified" | "unavailable" | "none";
}

const EMPTY_REF: Ref = { sizes: [], colors: [] };

export function resolveRef(ref: Ref, ctx: ResolverContext, fallback?: ShowItem): Resolved {
  const item = ref.code
    ? (ctx.items.find((i) => i.code === ref.code) ?? (ctx.currentItem?.code === ref.code ? ctx.currentItem : undefined))
    : fallback;
  if (!item) return { qty: ref.qty, unavailable: false, fit: "none" };
  let size: string | undefined;
  let color: string | undefined;
  let qty = ref.qty;
  let unavailable = false;
  for (const s of ref.sizes) {
    const hit = matchSize(item, s.candidates);
    if (!hit && /^\d+x$/.test(s.raw)) {
      qty = parseInt(s.raw, 10); // "3x" on an item without a 3X size is a quantity
      continue;
    }
    size = hit ?? s.candidates[0] ?? s.raw;
    if (!hit) unavailable = true;
  }
  const aliases = colorAliases(item);
  const titleWords = new Set(item.title.toLowerCase().split(/[^a-z0-9À-ɏ]+/));
  for (const ws of ref.colors) {
    const hit = aliases.get(ws.join(" ")) ?? aliases.get(ws.join("")) ?? aliases.get(ws.map(canonColor).join(" ")) ?? ws.map((w) => aliases.get(canonColor(w))).find(Boolean);
    if (!hit && ws.every((w) => titleWords.has(w))) continue; // "48 green dino": the colour is part of the item's name
    color = hit ?? canonColor(ws[0]!);
    if (!hit) unavailable = true;
  }
  const { fit } = variantFit(item, size, color);
  return { code: item.code, byTitle: ref.byTitle, size, color, qty, unavailable: unavailable || fit === "unavailable", fit };
}

/** A grant is only as good as the variant it can hold: unavailable 0.6, unspecified 0.75. */
const fitCap = (r: Resolved) => (r.unavailable ? 0.6 : r.fit === "underspecified" ? 0.75 : r.byTitle ? 0.85 : 1);

function toIntent(kind: IntentKind, r: Resolved, confidence: number, rationale: string, extra: Partial<RuleIntent> = {}): RuleIntent {
  const intent: RuleIntent = { kind, confidence: Math.round(confidence * 100) / 100, rationale, ...extra };
  if (r.code) intent.itemCode = r.code;
  if (r.size) intent.size = r.size;
  if (r.color) intent.color = r.color;
  if (r.qty !== undefined) intent.qty = r.qty;
  return intent;
}

const one = (intent: RuleIntent, needsLlm = false): RuleOutcome => ({ intents: [intent], needsLlm });

/**
 * Stage 1: deterministic resolution, precision first. Rules grant only unambiguous first-person claims;
 * everything else is capped below the grant line and routed to the LLM or the seller. When the comment
 * is positively not this viewer claiming now (someone else's claim, a negation, a past report, a wish,
 * a non-item object) or its number is ambiguous or unknown, no later stage may auto-grant either: the
 * LLM can pick a reading, but the seller confirms it.
 */
export function ruleResolve(text: string, ctx: ResolverContext): RuleOutcome {
  const p = parse(text, ctx);
  const out = decide(p, ctx);
  const reasons: [unknown, string][] = [
    [p.notSpeaker, `not the speaker's claim: ${p.notSpeaker}`],
    [p.objectUnknown, "claims something not in the catalogue"],
    [p.hypothetical && !p.soldCue, "a wish or hypothetical, not a claim now"],
    [p.ambiguousCodeSize, "number is both a code and a size"],
    [p.unknownNums.length > 0, `number ${p.unknownNums[0]} is not a listed code`],
    [!p.cue && p.refs.length > 0 && !p.refs.some((r) => r.code), "a size or colour with no claim word"],
  ];
  const capReason = reasons.find(([when]) => when)?.[1];
  if (capReason) Object.assign(out, { llmCap: REVIEW_CAP, capReason });
  return out;
}

export interface CommentEvidence {
  /** Item codes the comment itself names: written codes, slot letters, a title word unique to one item. */
  codes: Set<string>;
  /** Points at an item by position ("the last one", "pichla wala"). */
  position: boolean;
  /** Carries a claim or change word, or is nothing but a code (the "type the number" convention). */
  cue: boolean;
}

/** What a comment says on its face, used to check an LLM answer against the text it came from. */
export function commentEvidence(text: string, ctx: ResolverContext): CommentEvidence {
  const p = parse(text, ctx);
  const codes = new Set<string>();
  for (const r of p.roles) if (r.r === "code" || r.r === "title") codes.add(r.code);
  for (const n of p.negated) codes.add(n.code);
  const byKey = new Map(ctx.items.map((i) => [i.code.toLowerCase(), i.code]));
  if (isLettered(byKey.keys())) {
    for (const t of p.tokens) if (/^[b-hj-z]$/.test(t.t) && byKey.has(t.t)) codes.add(byKey.get(t.t)!);
  }
  // Mirrors the rules: a lone single-digit code collides with counts and answers, so it is not a claim word.
  const coded = p.refs.filter((r) => r.code && !r.byTitle);
  // The convention only holds for the item on air; a bare number for another item is not a claim word either.
  const onScreen = !ctx.currentItem || coded.every((r) => r.code === ctx.currentItem!.code);
  const bareCode = onScreen && coded.length > 0 && coded.some((r) => r.code!.length >= 2 || r.sizes.length > 0 || r.colors.length > 0) && p.chatter.length === 0 && !p.unknownNums.length && !p.question;
  return { codes, position: POSITION.test(p.text), cue: p.cue || p.change || bareCode };
}

function decide(p: Parsed, ctx: ResolverContext): RuleOutcome {
  const current = ctx.currentItem;
  const codeRefs = p.refs.filter((r) => r.code);
  const numRefs = codeRefs.filter((r) => !r.byTitle);
  const attrOnly = p.refs.length > 0 && codeRefs.length === 0;
  const chatterN = p.chatter.length;
  const anyClaim = p.claimStrong || p.claimWeak;
  const withAttrs = (r: Ref) => r.sizes.length > 0 || r.colors.length > 0 || r.qty !== undefined;
  // "romper 3T pink": a distinctive title word plus a variant is a claim even without "sold".
  const titleAttr = codeRefs.length > 0 && numRefs.length === 0 && codeRefs.some(withAttrs) && chatterN <= 1;
  const targets = (useCurrent: boolean) =>
    codeRefs.length ? codeRefs.map((r) => resolveRef(r, ctx)) : useCurrent && current ? [resolveRef(p.refs[0] ?? EMPTY_REF, ctx, current)] : [];

  if (p.emojiOnly && p.refs.length === 0 && !p.claimStrong) return one({ kind: "other", confidence: 0.9, rationale: "emoji only" });
  const distinctCodes = new Set(codeRefs.map((r) => r.code));
  if (p.orBetweenCodes || (distinctCodes.size > 1 && /\b(or|whichever|either)\b/.test(p.text) && !p.change)) {
    return one({ kind: "question", confidence: 0.3, rationale: "ambiguous: more than one item offered" });
  }

  if (p.waitlist && !/^(cancel|cxl|remove|take me off)/.test(p.text)) {
    const refs = targets(true);
    if (!refs.length) return one({ kind: "waitlist", confidence: 0.6, rationale: "waitlist cue, no item" }, true);
    return { intents: refs.map((r) => toIntent("waitlist", r, Math.min(0.9, fitCap(r) + 0.15), "waitlist cue")), needsLlm: false };
  }

  const negFrom = p.negated.find((n) => n.how === "neg")?.code;
  const isChange =
    p.change || (p.cancel && anyClaim && codeRefs.length >= 2) || (!!negFrom && numRefs.length > 0 && !p.cancel) || (p.variantNegated && p.refs.length > 0 && !p.question);
  if (isChange) {
    const named = /\b(?:instead of|en vez de)\s+#?(\w+)/.exec(p.text)?.[1] ?? /#?(\w+)\s+(?:ki jagah|ke badle)/.exec(p.text)?.[1];
    let from: string | undefined;
    let toRefs = codeRefs;
    if (named && codeRefs.some((r) => r.code === named)) {
      from = named;
      toRefs = codeRefs.filter((r) => r.code !== named);
    } else if (negFrom) from = negFrom;
    else if (codeRefs.length >= 2) {
      from = codeRefs[0]!.code;
      toRefs = codeRefs.slice(1);
    }
    const resolved = toRefs.length ? toRefs.map((r) => resolveRef(r, ctx)) : current ? [resolveRef(p.refs[0] ?? EMPTY_REF, ctx, current)] : [];
    const first = resolved[0];
    if (!first?.code) return one({ kind: "change", confidence: 0.5, rationale: "change cue, target unclear", ...(from && { fromItemCode: from }) }, true);
    const variantSwap = !from && resolved.length === 1 && (first.size !== undefined || first.color !== undefined || first.qty !== undefined);
    const conf = from || variantSwap ? 0.88 : 0.72;
    return {
      intents: resolved.map((r) => toIntent("change", r, Math.min(conf, fitCap(r) + 0.15), from ? `change from ${from}` : "change cue", from ? { fromItemCode: from } : {})),
      needsLlm: conf < 0.8,
    };
  }

  if (p.cancel && !p.notSpeaker) {
    const conflict = p.claimStrong && !EXPLICIT_CANCEL.test(p.text);
    const refs = codeRefs.map((r) => resolveRef(r, ctx));
    if (!refs.length) return one({ kind: "cancel", confidence: conflict ? 0.5 : 0.85, rationale: "cancel cue, applies to latest claim" }, conflict);
    return { intents: refs.map((r) => toIntent("cancel", r, conflict ? 0.6 : 0.92, "cancel cue")), needsLlm: conflict };
  }

  if (p.notSpeaker && anyClaim) {
    if (p.question) return one({ kind: "question", confidence: p.qmark ? 0.9 : 0.75, rationale: `question; not the speaker's claim (${p.notSpeaker})` });
    return one({ kind: "other", confidence: 0.5, rationale: `not the speaker's claim (${p.notSpeaker})` }, true);
  }
  if (p.howTo) return one({ kind: "question", confidence: 0.8, rationale: "asks how to claim" });

  // A question that also carries a clear claim ("sold 4 M, does it come in navy?") stays a claim.
  const claimDespiteQuestion = p.question && p.claimStrong && (p.refs.length > 0 || !p.qmark);
  if (p.question && !claimDespiteQuestion) {
    const conf = p.qmark ? 0.9 : 0.75;
    const why = p.qmark ? "question mark" : "question words";
    const r = codeRefs.length ? resolveRef(codeRefs[0]!, ctx) : p.refs.length && current ? resolveRef(p.refs[0]!, ctx, current) : undefined;
    return one(r ? toIntent("question", r, conf, why) : { kind: "question", confidence: conf, rationale: why }, !p.qmark && anyClaim);
  }

  if (p.unknownNums.length && !codeRefs.length) {
    if (anyClaim || p.refs.length) return one({ kind: "question", confidence: 0.25, rationale: `code ${p.unknownNums[0]} is not in this show` });
    if (chatterN === 0) return one({ kind: "other", confidence: 0.4, rationale: `bare number ${p.unknownNums[0]} matches no code` }, true);
  }
  if (p.backRef && anyClaim && !numRefs.length) return one({ kind: "question", confidence: 0.3, rationale: "claims an earlier item without naming it" });

  if (anyClaim || numRefs.length || titleAttr || (attrOnly && current && chatterN === 0)) {
    if (p.hypothetical && !p.claimStrong && !numRefs.length) return one({ kind: "other", confidence: 0.5, rationale: "hypothetical, not a claim" }, true);
    if (!p.claimStrong && !numRefs.length && !titleAttr && !(attrOnly && current)) {
      if (codeRefs.length) return { intents: targets(false).map((r) => toIntent("claim", r, 0.7, "weak cue + title word")), needsLlm: true };
      if (current && chatterN === 0) return one(toIntent("claim", resolveRef(EMPTY_REF, ctx, current), 0.7, "weak cue, on-screen item"), true);
      return one({ kind: "other", confidence: 0.55, rationale: "weak claim cue with nothing to claim" }, true);
    }
    const refs = targets(true);
    if (!refs.length) return one({ kind: "question", confidence: 0.3, rationale: "claim with no item on screen" });
    if (!anyClaim && attrOnly && refs.every((r) => r.unavailable)) {
      return one({ kind: "other", confidence: 0.5, rationale: "mentions a variant the item does not have" }, true);
    }
    if (!p.claimStrong && chatterN >= 2) {
      return one({ kind: "other", confidence: 0.55, rationale: `code amid chatter (${p.chatter.slice(0, 3).join(" ")})` }, true);
    }
    // Without a first-person cue a number is only a convention, not a statement: "12 M" or "142" may grant,
    // a bare single digit ("1", "3") collides with counts, game picks and answers and goes to review.
    // A size or colour with no claim word ("pink 36", "red colour") is as often a stock question or a
    // request to see it as a claim: review.
    const bareCode = numRefs.some(withAttrs) || numRefs.every((r) => r.code!.length >= 2) ? 0.85 : 0.75;
    let base = p.claimStrong ? 0.95 : numRefs.length ? bareCode : REVIEW_CAP;
    let needsLlm = !p.claimStrong && !numRefs.length;
    const why = [p.claimStrong ? "claim cue" : numRefs.length ? "bare code" : titleAttr ? "title + variant" : "variant only"];
    const cap = (value: number, reason: string, llm = true) => {
      base = Math.min(base, value);
      needsLlm ||= llm;
      why.push(reason);
    };
    // Off the item on air, a bare number is as often a game guess, a typo or a late reply as a claim.
    // Kept out of the LLM too: it would re-grant a code typed on its own.
    if (!p.claimStrong && current && numRefs.some((r) => r.code !== current.code)) cap(REVIEW_CAP, "bare code for an item not on screen", false);
    if (!p.claimStrong && chatterN === 1) cap(0.7, "one stray word");
    if (p.claimStrong && chatterN >= 3) cap(0.78, "long comment");
    if (p.claimStrong && chatterN >= 1 && p.refs.length === 0) cap(REVIEW_CAP, "words beside the cue");
    if (p.objectUnknown) cap(0.6, "claims something not in the catalogue");
    if (p.unknownNums.length) cap(0.6, `number ${p.unknownNums[0]} is not a listed code`);
    if (p.grades && !codeRefs.length) cap(0.85, "grade read as the on-screen item", false);
    if (p.claimTypo) cap(0.85, "typo cue", false);
    if (p.ambiguousCodeSize) cap(0.5, "number is both a code and a size");
    if (p.qmark) cap(0.75, "also asks something");
    return {
      intents: refs.map((r) => {
        const notes = [...why, r.fit === "underspecified" ? "variant not given" : "", r.unavailable ? "variant not offered" : "", r.byTitle ? "item named by title" : ""];
        const mixed = r.byTitle && numRefs.length > 0 ? 0.75 : 1; // a title word beside a number is a weaker reference
        return toIntent("claim", r, Math.min(base, fitCap(r), mixed), notes.filter(Boolean).join(", "));
      }),
      needsLlm,
    };
  }

  // Nothing claim-like, but anything the rules cannot read (an item reference, Hindi, an unknown word)
  // goes to the LLM rather than being settled as chatter.
  const signal = p.refs.length > 0 || p.unknownNums.length > 0 || p.otherNums > 0 || p.deictic ? "item-like words without a cue" : p.hindi ? "Hindi without a known cue" : p.unknownShort ? "unknown words" : undefined;
  return one({ kind: "other", confidence: signal ? 0.6 : 0.85, rationale: signal ?? "no cue" }, !!signal);
}
