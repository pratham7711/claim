// Turbopack loader: the workspace packages are NodeNext ESM, so their relative imports end in ".js"
// while the files on disk are ".ts". Webpack handles that with resolve.extensionAlias; Turbopack does not.
module.exports = function stripJsExt(source) {
  return source.replace(/((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]+?)\.js\2/g, "$1$2$3$2");
};
