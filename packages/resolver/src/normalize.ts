export type TokenKind = "num" | "word" | "punct";

export interface Token {
  t: string;
  kind: TokenKind;
  start: number;
  end: number;
}

export interface Normalized {
  text: string;
  tokens: Token[];
  hasQuestionMark: boolean;
  /** The comment held nothing but emoji / punctuation before cleanup. */
  emojiOnly: boolean;
  /** Written partly in Devanagari or romanised Hindi. */
  hindi: boolean;
}

/** Devanagari spellings of the words the rules read, mapped onto their romanised form. */
const DEVANAGARI_WORDS: Record<string, string> = {
  "है": "hai", "हैं": "hai", "हे": "hai", "हो": "ho", "था": "tha", "थी": "thi", "थे": "the",
  "क्या": "kya", "कया": "kya", "कितने": "kitne", "कितना": "kitna", "कितनी": "kitni", "कैसे": "kaise", "कैसा": "kaisa",
  "कौन": "kaun", "कौनसा": "kaunsa", "कौनसी": "kaunsa", "कहाँ": "kahan", "कहां": "kahan", "कब": "kab", "किस": "kis",
  "कीमत": "price", "दाम": "price", "प्राइस": "price", "रेट": "rate", "साइज": "size", "साइज़": "size", "कलर": "color",
  "रंग": "color", "लंबाई": "length", "लेंथ": "length", "हाइट": "height", "डिलीवरी": "delivery", "पेमेंट": "payment",
  "मुझे": "mujhe", "मुझको": "mujhe", "मेरा": "mera", "मेरी": "meri", "मेरे": "mere", "हमें": "hume", "लिए": "liye", "लिये": "liye",
  "चाहिए": "chahiye", "चाहिये": "chahiye", "चाहिऐ": "chahiye", "बुक": "book", "बूक": "book", "ऑर्डर": "order", "आर्डर": "order",
  "कर": "kar", "करो": "karo", "करे": "kare", "करें": "kare", "करना": "karna", "करनी": "karni", "करिए": "kariye", "करिये": "kariye",
  "दो": "do", "दे": "de", "देना": "dena", "दीजिए": "dijiye", "दीजिये": "dijiye", "दिजिए": "dijiye", "रख": "rakh", "रखो": "rakho",
  "रखना": "rakhna", "लेना": "lena", "लेनी": "leni", "लूंगी": "lungi", "लूँगी": "lungi", "लूंगा": "lunga", "लूँगा": "lunga",
  "भेज": "bhej", "भेजो": "bhejo", "दिखाओ": "dikhao", "दिखा": "dikhao", "दिखाइए": "dikhao", "दिखाइये": "dikhao",
  "बताओ": "batao", "बताइए": "batao", "बताइये": "batao", "बता": "batao", "नहीं": "nahi", "नही": "nahi", "मत": "mat",
  "कैंसल": "cancel", "कैंसिल": "cancel", "बदल": "badal", "बदलो": "badlo", "जगह": "jagah", "भी": "bhi", "ये": "ye", "यह": "ye",
  "वो": "wo", "वह": "wo", "वाला": "wala", "वाली": "wali", "वाले": "wale", "का": "ka", "की": "ki", "के": "ke", "को": "ko",
  "में": "mein", "से": "se", "पर": "par", "जी": "ji", "दीदी": "didi", "दी": "di", "मैम": "mam", "मेम": "mam", "भैया": "bhaiya",
  "आप": "aap", "बोलो": "bolo", "साड़ी": "saree", "साडी": "saree", "सूट": "suit", "कुर्ता": "kurta", "कुर्ते": "kurta", "कुर्ती": "kurti",
  "गया": "gaya", "गई": "gayi", "गयी": "gayi", "लिया": "liya", "दिया": "diya", "किया": "kiya",
};

/**
 * Romanised Hindi is typed many ways; each spelling maps onto one form so the rules list each word
 * once. Multi-word values ("kar do") split glued verbs.
 */
const HINGLISH_SPELLINGS: Record<string, string> = {
  kr: "kar", kro: "karo", kre: "kare", krna: "karna", krni: "karni", krne: "karne", krke: "karke", krdo: "kar do",
  kardo: "kar do", krdoo: "kar do", kardoo: "kar do", krde: "kar de", karde: "kar de", krdena: "kar dena", kardena: "kar dena",
  krdijiye: "kar dijiye", kardijiye: "kar dijiye", krdijie: "kar dijiye", kardijie: "kar dijiye", krdiye: "kar dijiye",
  kariye: "kar dijiye", kijiye: "kar dijiye", kijie: "kar dijiye", krdiya: "kar diya", kardiya: "kar diya", krdi: "kar di", kardi: "kar di",
  dedo: "de do", dedijiye: "de dijiye", dedijie: "de dijiye", dijie: "dijiye", dejiye: "dijiye", dijiyega: "dijiye", dena: "dena",
  rakhdo: "rakh do", rakhlo: "rakh lo", rakhdena: "rakh dena", rakhiye: "rakh dijiye", rakho: "rakh do",
  bhejdo: "bhej do", bhejo: "bhej do", bhejiye: "bhej dijiye",
  muje: "mujhe", mjhe: "mujhe", mujhko: "mujhe", mujko: "mujhe", muze: "mujhe", mujhy: "mujhe", mujh: "mujhe", mujhe: "mujhe",
  mre: "mere", mery: "meri", mri: "meri", mra: "mera", hme: "hume", hame: "hume", humko: "hume", hamko: "hume",
  chaiye: "chahiye", chahie: "chahiye", chaye: "chahiye", chahiyea: "chahiye", chiye: "chahiye", chahiya: "chahiye",
  chaahiye: "chahiye", chahye: "chahiye", chahiey: "chahiye", chayiye: "chahiye", chaiya: "chahiye", chahia: "chahiye", chahiyee: "chahiye",
  nhi: "nahi", nahin: "nahi", nhin: "nahi", nai: "nahi", nahee: "nahi", nahii: "nahi",
  kese: "kaise", kase: "kaise", kayse: "kaise", kaese: "kaise", kesy: "kaise", kaisy: "kaise", kaisay: "kaise",
  kon: "kaun", konsa: "kaunsa", konsi: "kaunsa", kaunsi: "kaunsa", konse: "kaunsa", kaunse: "kaunsa", ktne: "kitne", ktna: "kitna",
  kaha: "kahan",
  btao: "batao", btaiye: "batao", bataiye: "batao", bataye: "batao", btaye: "batao", btado: "batao", btana: "batao",
  batana: "batao", bataiyee: "batao", btaiyee: "batao", batayiye: "batao", btayiye: "batao", batado: "batao",
  dikhao: "dikhao", dikhado: "dikhao", dikhaiye: "dikhao", dikhayiye: "dikhao", dikhaye: "dikhao", dikhana: "dikhao",
  dikhaao: "dikhao", dikha: "dikhao", dikhaiyega: "dikhao", dikhaoo: "dikhao", dikhayo: "dikhao", dikhai: "dikhao",
  hy: "hai", hae: "hai", hain: "hai", hei: "hai",
  sadi: "saree", saadi: "saree", sari: "saree", saari: "saree", sarree: "saree", sarri: "saree",
  kalar: "color", colur: "color", colr: "color", colour: "color", rang: "color", saiz: "size", saij: "size", sise: "size",
  buk: "book", bukk: "book", bookig: "booking", bukking: "booking",
  hogaya: "ho gaya", hogya: "ho gaya", hogyi: "ho gayi", hogayi: "ho gayi", gya: "gaya", gyi: "gayi", gyaa: "gaya",
  kiya: "kiya", kia: "kiya", kiyaa: "kiya", liyaa: "liya", diyaa: "diya",
};

/** Words that only occur in Hindi, so they mark a comment as Hinglish. */
const HINDI_MARKERS = new Set(
  ("hai kya nahi mujhe mera meri mere chahiye kar karo dijiye wala wali wale bhi aap aapka apka ji didi bhaiya ka ki ke ko se mein " +
    "kaise kitne kitna kitni kaun kaunsa kahan batao dikhao rakh liye lena leni lungi lunga hume humara tha thi gaya gayi kiya liya " +
    "diya yeh ye iska iski isko isme usko unko inko uska uski unka acha accha bahut sab hogaya karna karni kare saree").split(" "),
);
/** Romanised words that are also English; read as Hindi only inside a Hinglish comment. */
const HINDI_IN_CONTEXT: Record<string, string> = { he: "hai", h: "hai", hu: "hoon", hun: "hoon" };

const HAND_RAISE = /[🙋✋🖐☝🤚]/gu;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/gu;
const TOKEN_RE = /\d+(?:\.\d+)?|[a-z\u00c0-\u024f\u0900-\u097f]+(?:'[a-z]+)?|[?\/,&+*$₹#-]/gu;

/**
 * Lower-case, unify digits and emoji, collapse elongations ("soooold" -> "sold", but not "xxl"),
 * and tokenise with offsets so later passes can tell glued tokens ("2x", "x2", "w30") from spaced ones.
 */
export function normalize(raw: string): Normalized {
  let text = raw.normalize("NFKC");
  const hasQuestionMark = /[?¿？]/.test(text);
  const stripped = text.replace(PICTOGRAPHIC, "").replace(/[\s\p{P}\p{S}\uFE0F\u20E3\u200D]/gu, "");
  const emojiOnly = stripped.length === 0 && /\p{Extended_Pictographic}/u.test(text);

  text = text
    .replace(/([0-9])\uFE0F?\u20E3/g, " $1 ")
    .replace(/🔟/gu, " 10 ")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\u200D[♀♂]\uFE0F?/gu, "")
    .replace(HAND_RAISE, " me ")
    .replace(PICTOGRAPHIC, " ")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[\u0900-\u097f]+/g, (w) => ` ${DEVANAGARI_WORDS[w] ?? w} `)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/¿/g, " ")
    .replace(/\bm{3,}\b/g, "hmm")
    .replace(/([a-wyz])\1{2,}/g, "$1")
    .replace(/[a-z]+/g, (w) => HINGLISH_SPELLINGS[w] ?? w)
    .replace(/\s+/g, " ")
    .trim();

  const latin = text.match(/[a-z]+/g) ?? [];
  const hindi = /[\u0900-\u097f]/.test(raw) || latin.filter((w) => HINDI_MARKERS.has(w)).length >= (latin.length <= 3 ? 1 : 2);
  if (hindi) text = text.replace(/\b[a-z]+\b/g, (w) => HINDI_IN_CONTEXT[w] ?? w);

  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const kind: TokenKind = /^\d/.test(t) ? "num" : /^[?\/,&+*$₹#-]$/.test(t) ? "punct" : "word";
    tokens.push({ t, kind, start: m.index, end: m.index + t.length });
  }
  return { text, tokens, hasQuestionMark, emojiOnly, hindi };
}

export const glued = (a: Token | undefined, b: Token | undefined) => !!a && !!b && a.end === b.start;
