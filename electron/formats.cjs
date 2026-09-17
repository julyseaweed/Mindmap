const path = require('node:path');

const OPEN_EXTENSIONS = Object.freeze(['mindmap', 'md', 'markdown', 'mmd', 'mermaid']);
const isSupportedFile = file => typeof file === 'string' && OPEN_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase());

module.exports = { OPEN_EXTENSIONS, isSupportedFile };
