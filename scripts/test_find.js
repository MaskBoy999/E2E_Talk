const fs = require('fs');
const code = fs.readFileSync('X:/Documents/GitHub/E2E_Talk/static/chat.js', 'utf-8');
console.log(`File length: ${code.length} chars, ${code.split('\n').length} lines`);

// Test finding highlightGeneric
const name = 'highlightGeneric';
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
console.log(`Escaped name: '${escaped}'`);

const patternStr = '(?:async\\s+)?function\\s+' + escaped + '\\s*\\(';
console.log(`Pattern string: '${patternStr}'`);

const pattern = new RegExp(patternStr);
console.log(`Pattern: ${pattern}`);

const m = pattern.exec(code);
if (m) {
    const startLine = code.slice(0, m.index).split('\n').length;
    console.log(`Found at line ${startLine}: '${code.slice(m.index, m.index + 60)}'`);
} else {
    console.log('NOT FOUND');
    // Try simpler pattern
    const simplePat = new RegExp('function\\s+' + escaped);
    const m2 = simplePat.exec(code);
    if (m2) {
        const startLine = code.slice(0, m2.index).split('\n').length;
        console.log(`Simple pattern found at line ${startLine}: '${code.slice(m2.index, m2.index + 60)}'`);
    } else {
        console.log('NOT FOUND even with simple pattern');
    }
}

// Try finding ALL functions containing 'highlight'
const allMatch = code.match(/function\s+\w*highlight\w*/g);
console.log(`\nFunctions containing 'highlight': ${JSON.stringify(allMatch)}`);
