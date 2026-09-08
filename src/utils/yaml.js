import YAML from 'yaml';

export function safeLoad(content) {
    // In this project, YAML input is always a string (e.g. subscription text).
    return YAML.parse(String(content));
}

export function safeDump(content, options = {}) {
    return YAML.stringify(content, options);
}

export default {
    safeLoad,
    safeDump,
    parse: safeLoad,
};
