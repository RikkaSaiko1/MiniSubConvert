const esbuild = require('esbuild');
const peggy = require('peggy');
const fs = require('node:fs');
const path = require('node:path');

const PATHS = createPaths();

function createPaths() {
    const rootDir = path.resolve(__dirname, '..');
    const buildDir = path.join(rootDir, '.build');
    const buildSrcDir = path.join(buildDir, 'src');
    const buildParsersDir = path.join(buildSrcDir, 'core/proxy-utils/parsers');
    const buildPeggyDir = path.join(buildParsersDir, 'peggy');

    return {
        rootDir,
        srcDir: path.join(rootDir, 'src'),
        rootTsconfigPath: path.join(rootDir, 'jsconfig.json'),
        buildDir,
        buildSrcDir,
        buildTsconfigPath: path.join(buildDir, 'jsconfig.json'),
        buildPeggyDir,
        buildGeneratedDir: path.join(buildPeggyDir, 'generated'),
        buildParsersIndexPath: path.join(buildParsersDir, 'index.js'),
        nodeEntryPath: path.join(buildSrcDir, 'node.js'),
        nodeOutputPath: path.join(rootDir, 'dist/minisubconvert.js'),
        proxyUtilsEntryPath: path.join(buildSrcDir, 'core/proxy-utils/index.js'),
        proxyUtilsOutputPath: path.join(rootDir, 'dist/proxy-utils.js'),
    };
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function prepareBuildWorkspace() {
    fs.rmSync(PATHS.buildDir, { recursive: true, force: true });
    ensureDir(PATHS.buildDir);
    fs.cpSync(PATHS.srcDir, PATHS.buildSrcDir, { recursive: true });
    fs.copyFileSync(PATHS.rootTsconfigPath, PATHS.buildTsconfigPath);
}

/**
 * Get peggy source .js files that contain embedded grammars.
 * These files follow the pattern:
 *   import peggy from 'peggy';
 *   const grammars = String.raw`...`;
 *   ...
 *   peggy.generate(grammars);
 */
function getPeggySourceFiles() {
    // 同目录允许普通 JavaScript 解析器，仅预编译含嵌入 grammar 的文件。
    const jsFiles = fs
        .readdirSync(PATHS.buildPeggyDir)
        .filter(
            (fileName) =>
                fileName.endsWith('.js') &&
                fs
                    .readFileSync(
                        path.join(PATHS.buildPeggyDir, fileName),
                        'utf-8',
                    )
                    .includes('String.raw`'),
        )
        .sort();

    if (jsFiles.length === 0) {
        throw new Error(
            `No .js files found in ${PATHS.buildPeggyDir}`,
        );
    }

    return jsFiles;
}

/**
 * Extract the grammar string from a peggy source .js file.
 * The grammar is embedded between String.raw` and the closing backtick.
 */
function extractGrammar(source) {
    const startMarker = 'String.raw`';
    const startIdx = source.indexOf(startMarker);
    if (startIdx === -1) {
        return null;
    }

    const grammarStart = startIdx + startMarker.length;

    // Find the closing backtick - need to handle escaped backticks
    let depth = 0;
    let i = grammarStart;
    while (i < source.length) {
        if (source[i] === '\\') {
            i += 2; // skip escaped char
            continue;
        }
        if (source[i] === '`') {
            if (depth === 0) {
                return source.substring(grammarStart, i);
            }
        }
        i++;
    }

    return null;
}

function createParserModuleCode(jsFileName, parserSource) {
    return [
        `// Auto-generated from ${jsFileName} - DO NOT EDIT`,
        parserSource,
        '',
        'let cachedParser = null;',
        'export default function getParser() {',
        '    if (!cachedParser) {',
        '        cachedParser = peg$parse;',
        '        cachedParser.parse = peg$parse;',
        '    }',
        '    return cachedParser;',
        '}',
        '',
    ].join('\n');
}

function compilePeggyFromSource(jsFileName) {
    const sourcePath = path.join(PATHS.buildPeggyDir, jsFileName);
    const baseName = path.parse(jsFileName).name;
    const outputPath = path.join(PATHS.buildGeneratedDir, `${baseName}.js`);

    const source = fs.readFileSync(sourcePath, 'utf-8');
    const grammar = extractGrammar(source);

    if (!grammar) {
        throw new Error(
            `Could not extract grammar from ${jsFileName}. ` +
            `Expected a String.raw\` template literal.`,
        );
    }

    const parserSource = peggy.generate(grammar, {
        output: 'source',
        format: 'es',
    });

    fs.writeFileSync(
        outputPath,
        createParserModuleCode(jsFileName, parserSource),
        'utf-8',
    );
    console.log(`  Generated: ${path.relative(PATHS.rootDir, outputPath)}`);
}

/**
 * Rewrite imports in parsers/index.js to point to pre-compiled generated modules
 * instead of the runtime-compiled peggy source files.
 *
 * Transforms:
 *   from './peggy/surge'  →  from './peggy/generated/surge'
 *   from './peggy/loon'   →  from './peggy/generated/loon'
 */
function rewriteParserIndexImports(sourceFiles) {
    const source = fs.readFileSync(PATHS.buildParsersIndexPath, 'utf-8');
    let rewritten = source;

    // 只重写实际生成的 Peggy 解析器，保留同目录中的普通 JavaScript 解析器。
    for (const jsFileName of sourceFiles) {
        const parserName = path.parse(jsFileName).name;
        rewritten = rewritten.replaceAll(
            `./peggy/${parserName}`,
            `./peggy/generated/${parserName}`,
        );
    }

    if (rewritten !== source) {
        fs.writeFileSync(PATHS.buildParsersIndexPath, rewritten, 'utf-8');
        console.log(
            `  Rewired: ${path.relative(PATHS.rootDir, PATHS.buildParsersIndexPath)}`,
        );
    }
}

function compilePeggyParsers() {
    prepareBuildWorkspace();
    ensureDir(PATHS.buildGeneratedDir);

    const sourceFiles = getPeggySourceFiles();

    console.log('Pre-compiling Peggy grammars from embedded sources...');

    for (const jsFileName of sourceFiles) {
        compilePeggyFromSource(jsFileName);
    }

    rewriteParserIndexImports(sourceFiles);
    console.log(`Generated ${sourceFiles.length} parser modules.`);
}

async function buildBundle(entryPath, outputPath, banner) {
    ensureDir(path.dirname(outputPath));

    await esbuild.build({
        entryPoints: [entryPath],
        outfile: outputPath,
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        sourcemap: false,
        banner: banner ? { js: banner } : undefined,
        tsconfig: PATHS.buildTsconfigPath,
        logLevel: 'info',
    });
}

async function buildNodeBundle() {
    await buildBundle(PATHS.nodeEntryPath, PATHS.nodeOutputPath, '#!/usr/bin/env node');
}

async function buildProxyUtilsBundle() {
    await buildBundle(PATHS.proxyUtilsEntryPath, PATHS.proxyUtilsOutputPath);
}

async function main() {
    try {
        compilePeggyParsers();
        await buildNodeBundle();
        await buildProxyUtilsBundle();
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

main();
