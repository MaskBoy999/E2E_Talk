#!/usr/bin/env node
/**
 * Generate the single source icon PNG (interlocking rings design).
 * Run: node tools/generate-source-icon.mjs
 * 
 * This creates src-tauri/icons/source/box-icon.png - the single source of truth
 * for all platform icons. The new design: two interlocking rings (gold top-right,
 * cyan bottom-left) on dark background with a white info icon element.
 */

import { writeFileSync } from 'node:fs';
import { createCanvas } from 'canvas';

const SIZE = 1024;
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

// Dark background with rounded corners
const bgColor = '#0d0d1a';
const radius = SIZE * 0.045; // ~4.5% for rounded corners

// Draw rounded rectangle background
ctx.fillStyle = bgColor;
roundRect(ctx, 0, 0, SIZE, SIZE, radius);
ctx.fill();

// Ring parameters
const ringRadius = SIZE * 0.165;  // ~16.5% of canvas
const ringThickness = SIZE * 0.035; // ~3.5%
const dotRadius = SIZE * 0.075;   // ~7.5%

// Offsets from center for interlocking effect
const offsetX = SIZE * 0.055;
const offsetY = SIZE * 0.055;

const centerX = SIZE / 2;
const centerY = SIZE / 2;

// Gold ring (top-right position)
const goldCx = centerX + offsetX;
const goldCy = centerY - offsetY;
const goldColor = '#d4a843';

// Cyan ring (bottom-left position)
const cyanCx = centerX - offsetX;
const cyanCy = centerY + offsetY;
const cyanColor = '#4fc3f7';

// Draw gold ring
ctx.strokeStyle = goldColor;
ctx.lineWidth = ringThickness;
ctx.beginPath();
ctx.arc(goldCx, goldCy, ringRadius, 0, Math.PI * 2);
ctx.stroke();

// Draw gold center dot
ctx.fillStyle = goldColor;
ctx.beginPath();
ctx.arc(goldCx, goldCy, dotRadius, 0, Math.PI * 2);
ctx.fill();

// Draw cyan ring
ctx.strokeStyle = cyanColor;
ctx.lineWidth = ringThickness;
ctx.beginPath();
ctx.arc(cyanCx, cyanCy, ringRadius, 0, Math.PI * 2);
ctx.stroke();

// Draw cyan center dot
ctx.fillStyle = cyanColor;
ctx.beginPath();
ctx.arc(cyanCx, cyanCy, dotRadius, 0, Math.PI * 2);
ctx.fill();

// White info icon element (right side) - small "i" indicator
const infoX = centerX + offsetX * 1.5 + ringRadius * 0.6;
const infoY = centerY - offsetY * 1.5;

ctx.fillStyle = '#ffffff';

// Info dot
ctx.beginPath();
ctx.arc(infoX, infoY - SIZE * 0.1, SIZE * 0.015, 0, Math.PI * 2);
ctx.fill();

// Info vertical bar
const barWidth = SIZE * 0.018;
const barHeight = SIZE * 0.055;
const barX = infoX - barWidth / 2;
const barY = infoY - barHeight / 2;
roundRect(ctx, barX, barY, barWidth, barHeight, barWidth / 2);
ctx.fill();

// Save the image
const outputPath = './src-tauri/icons/source/box-icon.png';
writeFileSync(outputPath, canvas.toBuffer('image/png'));
console.log(`Generated source icon: ${outputPath} (${SIZE}x${SIZE})`);

// Helper functions
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
