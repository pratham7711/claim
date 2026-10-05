/** Multi-word phrases are matched longest-first over word tokens. Values are canonical labels. */
export const SIZE_PHRASES: [string[], string][] = [
  [["extra", "small"], "XS"],
  [["x", "small"], "XS"],
  [["xs"], "XS"],
  [["xsmall"], "XS"],
  [["small"], "S"],
  [["smalls"], "S"],
  [["sm"], "S"],
  [["s"], "S"],
  [["medium"], "M"],
  [["mediums"], "M"],
  [["med"], "M"],
  [["meds"], "M"],
  [["m"], "M"],
  [["large"], "L"],
  [["larges"], "L"],
  [["lg"], "L"],
  [["l"], "L"],
  [["double", "extra", "large"], "XXL"],
  [["double", "xl"], "XXL"],
  [["extra", "extra", "large"], "XXL"],
  [["extra", "large"], "XL"],
  [["x", "large"], "XL"],
  [["xlarge"], "XL"],
  [["xl"], "XL"],
  [["xls"], "XL"],
  [["xxl"], "XXL"],
  [["xxls"], "XXL"],
  [["2xl"], "XXL"],
  [["triple", "xl"], "3XL"],
  [["xxxl"], "3XL"],
  [["3xl"], "3XL"],
  [["4xl"], "4XL"],
  [["5xl"], "5XL"],
  [["6xl"], "6XL"],
  [["free", "size"], "FREE"],
  [["freesize"], "FREE"],
  [["one", "size"], "FREE"],
];

const COLOR_LIST: [string, string?][] = [
  ["black"], ["white"], ["off white"], ["ivory"], ["cream"], ["beige"], ["nude"], ["tan"], ["khaki"], ["brown"],
  ["chocolate"], ["camel"], ["grey", "gray"], ["gray"], ["charcoal"], ["silver"], ["gold"], ["golden", "gold"], ["rose gold"],
  ["red"], ["wine"], ["wine red", "wine"], ["maroon"], ["burgundy"], ["rust"], ["orange"], ["peach"], ["coral"],
  ["yellow"], ["mustard"], ["lemon"], ["green"], ["olive"], ["olive green", "olive"], ["bottle green"], ["emerald"],
  ["mint"], ["mint green", "mint"], ["sage"], ["teal"], ["turquoise"], ["aqua"], ["blue"], ["navy"], ["navy blue", "navy"],
  ["royal blue"], ["sky blue"], ["baby blue"], ["light blue"], ["dark blue"], ["powder blue"], ["cobalt"], ["indigo"],
  ["pink"], ["baby pink"], ["light pink"], ["hot pink"], ["rani pink"], ["blush"], ["magenta"], ["fuchsia"],
  ["purple"], ["lavender"], ["lilac"], ["mauve"], ["plum"], ["violet"], ["multicolor", "multicolour"],
  ["multicolour"], ["multi colour", "multicolour"], ["multi color", "multicolour"], ["multi", "multicolour"],
  // Hinglish
  ["laal", "red"], ["lal", "red"], ["neela", "blue"], ["neeli", "blue"], ["peela", "yellow"], ["peeli", "yellow"],
  ["hara", "green"], ["hari", "green"], ["kaala", "black"], ["kala", "black"], ["kaali", "black"], ["safed", "white"],
  ["gulabi", "pink"], ["jamuni", "purple"], ["narangi", "orange"],
];

export const COLOR_PHRASES: [string[], string][] = COLOR_LIST.map(([phrase, canon]) => [phrase.split(" "), canon ?? phrase]);

export const GARMENTS = new Set([
  "dress", "dresses", "maxi", "midi", "mini", "gown", "top", "tops", "tee", "tees", "shirt", "shirts", "blouse", "blouses",
  "cardigan", "cardigans", "sweater", "sweaters", "jumper", "hoodie", "sweatshirt", "pullover", "knit", "knits", "jacket",
  "jackets", "coat", "coats", "blazer", "vest", "skirt", "skirts", "jeans", "denims", "pants", "trousers", "shorts", "leggings",
  "jumpsuit", "romper", "playsuit", "bodysuit", "kimono", "kaftan", "caftan", "tunic", "tunics", "coord", "co-ord", "cami",
  "camisole", "bralette", "tote", "bag", "bags", "purse", "clutch", "scarf", "shawl", "stole", "bracelet", "necklace",
  "earrings", "hat", "belt", "boots", "sandals", "heels", "sneakers",
  "saree", "sarees", "sari", "saris", "kurti", "kurtis", "kurta", "kurtas", "lehenga", "lehengas", "lehnga", "choli",
  "dupatta", "dupattas", "salwar", "suit", "suits", "anarkali", "palazzo", "palazzos", "sharara", "gharara", "churidar",
  "dhoti", "sherwani", "potli", "jhumka", "jhumkas", "bangles", "ghagra", "chaniya",
]);

/** Words that can carry an "a"/"an" quantity: "a small", "an XL". */
export const ARTICLE_QTY = new Set(["a", "an", "single"]);

export const PIECE_WORDS = new Set(["piece", "pieces", "pcs", "pc", "units", "unit", "available", "left"]);

export const CODE_CUES = new Set(["number", "no", "num", "item", "lot", "code", "style", "product", "#"]);

export const PRICE_CUES = new Set(["price", "priced", "for", "at", "just", "only", "costs", "cost", "rate", "mrp", "now", "selling"]);

export const PRICE_CUE_FILLERS = new Set(["is", "of", ":", "just", "only", "at", "a", "it's", "its"]);

export const CURRENCY_PREFIX: Record<string, "USD" | "INR"> = { $: "USD", usd: "USD", "₹": "INR", rs: "INR", inr: "INR", rupees: "INR" };

export const CURRENCY_SUFFIX: Record<string, "USD" | "INR"> = {
  dollars: "USD", dollar: "USD", bucks: "USD", buck: "USD", usd: "USD", $: "USD",
  rupees: "INR", rupee: "INR", rupaye: "INR", rupay: "INR", rs: "INR", inr: "INR", "₹": "INR", "/-": "INR",
};

/** Seeing any of these flips the parser into Indian mode: ₹ prices and Hindi number words. */
export const INDIAN_MARKERS = new Set([
  "₹", "rs", "inr", "rupees", "rupee", "rupaye", "sau", "hazaar", "hazar", "hajar", "lakh", "lakhs", "lac",
  "saree", "sarees", "sari", "kurti", "kurtis", "kurta", "lehenga", "dupatta", "salwar", "anarkali", "/-", "hai", "wala", "wali",
]);

export const LEAD_FILLERS = new Set([
  "okay", "ok", "alright", "all", "right", "so", "now", "next", "up", "and", "then", "um", "uh", "guys", "ladies", "hey",
  "here", "here's", "we", "have", "got", "is", "it's", "this", "the", "coming",
]);

/** Trimmed from either end of a title candidate. */
export const STOPWORDS = new Set([
  "okay", "ok", "alright", "all", "right", "so", "now", "next", "up", "is", "it", "it's", "its", "this", "that", "these",
  "those", "the", "a", "an", "our", "my", "here", "here's", "we", "we've", "we're", "i", "i've", "i'm", "have", "has", "got",
  "there", "there's", "are", "and", "or", "also", "plus", "with", "for", "at", "of", "in", "on", "just", "only", "guys",
  "ladies", "everyone", "folks", "friends", "check", "out", "look", "coming", "comes", "come", "available", "size", "sizes",
  "colour", "colours", "color", "colors", "item", "lot", "number", "price", "priced", "rate", "mrp", "piece", "pieces", "pcs",
  "left", "stock", "each", "let's", "lets", "you", "your", "um", "uh", "then", "very", "really", "one", "one's", "which",
  "hai", "ye", "yeh", "ji", "toh", "aur", "wala", "wali", "mein", "me", "ka", "ki", "ke", "bhi", "hain", "dekho", "hey",
  "selling", "sell", "go", "going", "what", "who", "wants", "want", "grab", "get",
]);

export const FLUFF = new Set([
  "gorgeous", "beautiful", "stunning", "lovely", "cute", "amazing", "super", "absolutely", "adorable", "perfect",
  "fabulous", "pretty", "sweet", "awesome", "fantastic", "brand", "new", "gorgeousss", "sundar", "khoobsurat", "mast",
  "favourite", "favorite", "best", "bestselling", "bestseller", "hot", "trending", "classic", "darling", "dreamy",
  "cutest", "prettiest", "loveliest", "softest", "comfy", "stylish", "elegant", "chic",
]);

/** Words allowed right after the last garment noun in a title: "kurta set", "dress with pockets". */
export const TITLE_TAIL = new Set(["set", "combo", "pair", "with"]);

export const SMALL_TITLE_WORDS = new Set(["and", "with", "of", "in", "for", "the", "a", "an", "or", "to"]);
