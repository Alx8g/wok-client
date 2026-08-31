#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO_ROOT = join(import.meta.dirname, '..');
const ASSET_DIR = join(REPO_ROOT, 'assets');
export const INSTALLER_ART_DIR = join(REPO_ROOT, 'build', 'installer');
export const INSTALLER_ART_FILES = Object.freeze({
	header: 'wok-header.bmp',
	side: 'wok-side.bmp'
});
export const INSTALLER_ART_SIZES = Object.freeze({
	header: Object.freeze({ width: 150, height: 57 }),
	side: Object.freeze({ width: 164, height: 314 })
});
const BRAND = {
	accent: '#FBC02D',
	ink: '#101014',
	white: '#FFFFFF',
	paper: '#FFFFFF',
	panelTop: '#131317',
	panelBottom: '#08080A',
	washA: '#FBC02D',
	washB: '#202840',
	washC: '#7B3131',
	rule: '#26262C',
	muted: '#71717A',
	headerCaption: '#6E6E75'
};
function parseColor(hex) {
	const value = hex.replace('#', '');
	if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`Unsupported colour: ${hex}`);
	return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}
function mixColor(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp(value, min, max) {
	return value < min ? min : value > max ? max : value;
}
function createCanvas(width, height, background) {
	const data = new Float64Array(width * height * 3);
	const canvas = { width, height, data };
	const base = parseColor(background);
	for (let i = 0; i < width * height; i++) {
		data[i * 3] = base[0];
		data[i * 3 + 1] = base[1];
		data[i * 3 + 2] = base[2];
	}
	return canvas;
}
function blendPixel(canvas, x, y, color, alpha) {
	if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
	const a = alpha > 1 ? 1 : alpha;
	const index = (y * canvas.width + x) * 3;
	canvas.data[index] += (color[0] - canvas.data[index]) * a;
	canvas.data[index + 1] += (color[1] - canvas.data[index + 1]) * a;
	canvas.data[index + 2] += (color[2] - canvas.data[index + 2]) * a;
}
function fillRect(canvas, x0, y0, width, height, color, alpha = 1) {
	const rgb = Array.isArray(color) ? color : parseColor(color);
	for (let y = y0; y < y0 + height; y++) {
		for (let x = x0; x < x0 + width; x++) blendPixel(canvas, x, y, rgb, alpha);
	}
}
function paint(canvas, shader) {
	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			const result = shader(x, y);
			if (result) blendPixel(canvas, x, y, result.color, result.alpha ?? 1);
		}
	}
}
const PATH_TOKEN = /[MmLlHhVvCcSsQqTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
function parsePathData(d) {
	const tokens = d.match(PATH_TOKEN) ?? [];
	const subpaths = [];
	let current = null;
	let cursor = { x: 0, y: 0 };
	let start = { x: 0, y: 0 };
	let previousControl = null;
	let command = '';
	let index = 0;
	const number = () => {
		const token = tokens[index++];
		const value = Number(token);
		if (!Number.isFinite(value)) throw new Error(`Malformed number in path data near "${token}"`);
		return value;
	};
	const point = (relative) => {
		const x = number();
		const y = number();
		return relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
	};
	const push = (segment) => {
		if (!current) throw new Error('Path data draws before its first moveto');
		current.segments.push(segment);
	};
	while (index < tokens.length) {
		if (/[A-Za-z]/.test(tokens[index])) {
			command = tokens[index++];
			if (/[Aa]/.test(command)) throw new Error('Elliptical arcs are not supported by the installer art rasteriser');
		} else if (command === 'M') {
			command = 'L';
		} else if (command === 'm') {
			command = 'l';
		}
		const relative = command === command.toLowerCase();
		switch (command.toUpperCase()) {
			case 'M': {
				const target = point(relative);
				current = { start: target, segments: [], closed: false };
				subpaths.push(current);
				cursor = target;
				start = target;
				previousControl = null;
				break;
			}
			case 'L': {
				const target = point(relative);
				push({ type: 'L', p: target });
				cursor = target;
				previousControl = null;
				break;
			}
			case 'H': {
				const x = number();
				const target = { x: relative ? cursor.x + x : x, y: cursor.y };
				push({ type: 'L', p: target });
				cursor = target;
				previousControl = null;
				break;
			}
			case 'V': {
				const y = number();
				const target = { x: cursor.x, y: relative ? cursor.y + y : y };
				push({ type: 'L', p: target });
				cursor = target;
				previousControl = null;
				break;
			}
			case 'C': {
				const c1 = point(relative);
				const c2 = point(relative);
				const target = point(relative);
				push({ type: 'C', c1, c2, p: target });
				cursor = target;
				previousControl = c2;
				break;
			}
			case 'S': {
				const reflected = previousControl ? { x: 2 * cursor.x - previousControl.x, y: 2 * cursor.y - previousControl.y } : { ...cursor };
				const c2 = point(relative);
				const target = point(relative);
				push({ type: 'C', c1: reflected, c2, p: target });
				cursor = target;
				previousControl = c2;
				break;
			}
			case 'Q': {
				const c = point(relative);
				const target = point(relative);
				push({ type: 'Q', c, p: target });
				cursor = target;
				previousControl = c;
				break;
			}
			case 'T': {
				const c = previousControl ? { x: 2 * cursor.x - previousControl.x, y: 2 * cursor.y - previousControl.y } : { ...cursor };
				const target = point(relative);
				push({ type: 'Q', c, p: target });
				cursor = target;
				previousControl = c;
				break;
			}
			case 'Z': {
				if (current) current.closed = true;
				cursor = start;
				previousControl = null;
				break;
			}
			default:
				throw new Error(`Unsupported path command "${command}"`);
		}
	}
	return subpaths;
}
function parseTransform(value) {
	let transform = { scale: 1, dx: 0, dy: 0 };
	if (!value) return transform;
	const operations = value.matchAll(/(translate|scale)\s*\(([^)]*)\)/g);
	for (const [, name, rawArguments] of operations) {
		const numbers = (rawArguments.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
		if (name === 'translate') {
			transform = { ...transform, dx: transform.dx + (numbers[0] ?? 0) * 1, dy: transform.dy + (numbers[1] ?? 0) * 1 };
		} else {
			const sx = numbers[0] ?? 1;
			const sy = numbers[1] ?? sx;
			if (Math.abs(sx - sy) > 1e-9) throw new Error('Non-uniform scale transforms are not supported');
			transform = { scale: transform.scale * sx, dx: transform.dx, dy: transform.dy };
		}
	}
	return transform;
}
function composeTransform(outer, inner) {
	return {
		scale: outer.scale * inner.scale,
		dx: outer.scale * inner.dx + outer.dx,
		dy: outer.scale * inner.dy + outer.dy
	};
}
function attribute(tag, name) {
	const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
	return match ? match[1] : undefined;
}
function parseSvgShapes(source) {
	const shapes = [];
	const stack = [{ transform: { scale: 1, dx: 0, dy: 0 }, fill: '#000000', stroke: 'none', strokeWidth: 1 }];
	const tags = source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)(svg|g|path)\b([^>]*?)(\/?)>/g);
	for (const [, closing, name, rawAttributes, selfClosing] of tags) {
		const top = stack[stack.length - 1];
		if (closing) {
			if (name !== 'svg' && stack.length > 1) stack.pop();
			continue;
		}
		const state = {
			transform: composeTransform(top.transform, parseTransform(attribute(rawAttributes, 'transform'))),
			fill: attribute(rawAttributes, 'fill') ?? top.fill,
			stroke: attribute(rawAttributes, 'stroke') ?? top.stroke,
			strokeWidth: Number(attribute(rawAttributes, 'stroke-width') ?? top.strokeWidth)
		};
		if (name === 'path') {
			const d = attribute(rawAttributes, 'd');
			if (!d) throw new Error('Found a <path> without path data');
			const subpaths = parsePathData(d).map((subpath) => transformSubpath(subpath, state.transform));
			if (state.fill && state.fill !== 'none') shapes.push({ kind: 'fill', subpaths, source: state.fill });
			if (state.stroke && state.stroke !== 'none') {
				shapes.push({
					kind: 'stroke',
					subpaths,
					source: state.stroke,
					width: state.strokeWidth * state.transform.scale
				});
			}
			continue;
		}
		if (!selfClosing) stack.push(state);
	}
	if (shapes.length === 0) throw new Error('No drawable paths found in SVG');
	return shapes;
}
function applyTransform(point, transform) {
	return { x: point.x * transform.scale + transform.dx, y: point.y * transform.scale + transform.dy };
}
function transformSubpath(subpath, transform) {
	return {
		start: applyTransform(subpath.start, transform),
		closed: subpath.closed,
		segments: subpath.segments.map((segment) => {
			if (segment.type === 'L') return { type: 'L', p: applyTransform(segment.p, transform) };
			if (segment.type === 'Q') {
				return { type: 'Q', c: applyTransform(segment.c, transform), p: applyTransform(segment.p, transform) };
			}
			return {
				type: 'C',
				c1: applyTransform(segment.c1, transform),
				c2: applyTransform(segment.c2, transform),
				p: applyTransform(segment.p, transform)
			};
		})
	};
}
function transformShapes(shapes, transform) {
	return shapes.map((shape) => ({
		...shape,
		subpaths: shape.subpaths.map((subpath) => transformSubpath(subpath, transform)),
		width: shape.width === undefined ? undefined : shape.width * transform.scale
	}));
}
const FLATTEN_STEP_PX = 0.35;
function curveSteps(points) {
	let length = 0;
	for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	return clamp(Math.ceil(length / FLATTEN_STEP_PX), 2, 256);
}
function flattenSubpath(subpath) {
	const points = [subpath.start];
	let cursor = subpath.start;
	for (const segment of subpath.segments) {
		if (segment.type === 'L') {
			points.push(segment.p);
		} else if (segment.type === 'Q') {
			const steps = curveSteps([cursor, segment.c, segment.p]);
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const u = 1 - t;
				points.push({
					x: u * u * cursor.x + 2 * u * t * segment.c.x + t * t * segment.p.x,
					y: u * u * cursor.y + 2 * u * t * segment.c.y + t * t * segment.p.y
				});
			}
		} else {
			const steps = curveSteps([cursor, segment.c1, segment.c2, segment.p]);
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const u = 1 - t;
				points.push({
					x: u * u * u * cursor.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t * t * t * segment.p.x,
					y: u * u * u * cursor.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t * t * t * segment.p.y
				});
			}
		}
		cursor = segment.p;
	}
	return points;
}
const CAP_STEPS = 12;
function strokeToPolygons(points, width) {
	const radius = width / 2;
	const polygons = [];
	const arc = (centre, from, to) => {
		const result = [];
		for (let i = 1; i < CAP_STEPS; i++) {
			const angle = from + ((to - from) * i) / CAP_STEPS;
			result.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
		}
		return result;
	};
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy);
		if (length < 1e-9) continue;
		const normal = { x: (-dy / length) * radius, y: (dx / length) * radius };
		const theta = Math.atan2(normal.y, normal.x);
		polygons.push([
			{ x: a.x + normal.x, y: a.y + normal.y },
			{ x: b.x + normal.x, y: b.y + normal.y },
			...arc(b, theta, theta - Math.PI),
			{ x: b.x - normal.x, y: b.y - normal.y },
			{ x: a.x - normal.x, y: a.y - normal.y },
			...arc(a, theta - Math.PI, theta - 2 * Math.PI)
		]);
	}
	if (polygons.length === 0 && points.length === 1) {
		const centre = points[0];
		const circle = [];
		for (let i = 0; i < CAP_STEPS * 2; i++) {
			const angle = (Math.PI * 2 * i) / (CAP_STEPS * 2);
			circle.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
		}
		polygons.push(circle);
	}
	return polygons;
}
function shapePolygons(shape) {
	const flattened = shape.subpaths.map(flattenSubpath);
	if (shape.kind === 'fill') return flattened;
	return flattened.flatMap((points) => strokeToPolygons(points, shape.width));
}
const SAMPLE_ROWS = 8;
function addSpan(coverage, x0, x1, weight) {
	const left = Math.max(0, x0);
	const right = Math.min(coverage.length, x1);
	if (right <= left) return;
	const first = Math.floor(left);
	const last = Math.min(coverage.length - 1, Math.floor(right - 1e-12));
	for (let x = first; x <= last; x++) {
		const overlap = Math.min(right, x + 1) - Math.max(left, x);
		if (overlap > 0) coverage[x] += overlap * weight;
	}
}
function fillPolygons(canvas, polygons, color, alpha = 1) {
	const rgb = Array.isArray(color) ? color : parseColor(color);
	const edges = [];
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const polygon of polygons) {
		for (let i = 0; i < polygon.length; i++) {
			const a = polygon[i];
			const b = polygon[(i + 1) % polygon.length];
			if (a.y === b.y) continue;
			edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, dir: b.y > a.y ? 1 : -1 });
			top = Math.min(top, a.y, b.y);
			bottom = Math.max(bottom, a.y, b.y);
		}
	}
	if (edges.length === 0) return;
	const coverage = new Float64Array(canvas.width);
	const firstRow = clamp(Math.floor(top), 0, canvas.height);
	const lastRow = clamp(Math.ceil(bottom), 0, canvas.height);
	const crossings = [];
	for (let py = firstRow; py < lastRow; py++) {
		coverage.fill(0);
		for (let sample = 0; sample < SAMPLE_ROWS; sample++) {
			const y = py + (sample + 0.5) / SAMPLE_ROWS;
			crossings.length = 0;
			for (const edge of edges) {
				const low = Math.min(edge.ay, edge.by);
				const high = Math.max(edge.ay, edge.by);
				if (y < low || y >= high) continue;
				const t = (y - edge.ay) / (edge.by - edge.ay);
				crossings.push({ x: edge.ax + t * (edge.bx - edge.ax), dir: edge.dir });
			}
			if (crossings.length < 2) continue;
			crossings.sort((a, b) => a.x - b.x);
			let winding = 0;
			for (let i = 0; i < crossings.length - 1; i++) {
				winding += crossings[i].dir;
				if (winding !== 0) addSpan(coverage, crossings[i].x, crossings[i + 1].x, 1 / SAMPLE_ROWS);
			}
		}
		for (let x = 0; x < canvas.width; x++) {
			if (coverage[x] > 0) blendPixel(canvas, x, py, rgb, Math.min(1, coverage[x]) * alpha);
		}
	}
}
function shapeBounds(shapes) {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const shape of shapes) {
		const padding = shape.kind === 'stroke' ? shape.width / 2 : 0;
		for (const subpath of shape.subpaths) {
			for (const point of flattenSubpath(subpath)) {
				minX = Math.min(minX, point.x - padding);
				minY = Math.min(minY, point.y - padding);
				maxX = Math.max(maxX, point.x + padding);
				maxY = Math.max(maxY, point.y + padding);
			}
		}
	}
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
function fitToWidth(shapes, targetWidth, x, y) {
	const bounds = shapeBounds(shapes);
	const scale = targetWidth / bounds.width;
	const transform = { scale, dx: x - bounds.minX * scale, dy: y - bounds.minY * scale };
	return { shapes: transformShapes(shapes, transform), height: bounds.height * scale };
}
function drawShapes(canvas, shapes, color) {
	for (const shape of shapes) fillPolygons(canvas, shapePolygons(shape), color);
}
const GLYPHS = {
	A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
	C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
	D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
	E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
	F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
	G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
	H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
	I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
	J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
	K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
	L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
	M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
	N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
	O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
	Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
	R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
	S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
	T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
	U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
	V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
	W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
	X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
	Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
	Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
	0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
	1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
	2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
	3: ['#####', '...#.', '..##.', '....#', '....#', '#...#', '.###.'],
	4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
	5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
	6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
	7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
	8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
	9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
	'.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
	'-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
	':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
	'/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
	' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....']
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
function captionWidth(text, scale, tracking) {
	return text.length * GLYPH_WIDTH * scale + Math.max(0, text.length - 1) * tracking;
}
function drawCaption(canvas, text, x, y, { color, scale = 1, tracking = 2 }) {
	const rgb = parseColor(color);
	let cursor = x;
	for (const character of text) {
		const glyph = GLYPHS[character];
		if (!glyph) throw new Error(`No caption glyph for "${character}"`);
		for (let row = 0; row < GLYPH_HEIGHT; row++) {
			for (let column = 0; column < GLYPH_WIDTH; column++) {
				if (glyph[row][column] !== '#') continue;
				fillRect(canvas, cursor + column * scale, y + row * scale, scale, scale, rgb);
			}
		}
		cursor += GLYPH_WIDTH * scale + tracking;
	}
}
function encodeBmp24(canvas) {
	const rowStride = (canvas.width * 3 + 3) & ~3;
	const pixelBytes = rowStride * canvas.height;
	const buffer = Buffer.alloc(54 + pixelBytes);
	buffer.write('BM', 0, 'ascii');
	buffer.writeUInt32LE(54 + pixelBytes, 2);
	buffer.writeUInt32LE(0, 6);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(canvas.width, 18);
	buffer.writeInt32LE(canvas.height, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(pixelBytes, 34);
	buffer.writeInt32LE(2835, 38);
	buffer.writeInt32LE(2835, 42);
	buffer.writeUInt32LE(0, 46);
	buffer.writeUInt32LE(0, 50);
	for (let y = 0; y < canvas.height; y++) {
		const sourceRow = canvas.height - 1 - y;
		let offset = 54 + y * rowStride;
		for (let x = 0; x < canvas.width; x++) {
			const index = (sourceRow * canvas.width + x) * 3;
			buffer[offset++] = Math.round(clamp(canvas.data[index + 2], 0, 255));
			buffer[offset++] = Math.round(clamp(canvas.data[index + 1], 0, 255));
			buffer[offset++] = Math.round(clamp(canvas.data[index], 0, 255));
		}
	}
	return buffer;
}
function loadMarkShapes() {
	return parseSvgShapes(readFileSync(join(ASSET_DIR, 'wok-mark.svg'), 'utf-8'));
}
function loadWordmarkShapes() {
	const shapes = parseSvgShapes(readFileSync(join(ASSET_DIR, 'full_logo.svg'), 'utf-8'));
	const wordmark = shapes.filter((shape) => shape.source.toUpperCase() === '#FFFFFF');
	if (wordmark.length === 0) throw new Error('No white wordmark path found in assets/full_logo.svg');
	return wordmark;
}
function loadHorizontalLockup() {
	const shapes = parseSvgShapes(readFileSync(join(ASSET_DIR, 'full_logo.svg'), 'utf-8'));
	return {
		mark: shapes.filter((shape) => shape.source.toUpperCase() === '#FBC02D'),
		wordmark: shapes.filter((shape) => shape.source.toUpperCase() === '#FFFFFF')
	};
}
function renderHeaderBitmap() {
	const { width, height } = INSTALLER_ART_SIZES.header;
	const canvas = createCanvas(width, height, BRAND.paper);
	const lockupWidth = 118;
	const lockupX = Math.round((width - lockupWidth) / 2);
	const { mark, wordmark } = loadHorizontalLockup();
	const combinedBounds = shapeBounds([...mark, ...wordmark]);
	const scale = lockupWidth / combinedBounds.width;
	const transform = { scale, dx: lockupX - combinedBounds.minX * scale, dy: 14 - combinedBounds.minY * scale };
	drawShapes(canvas, transformShapes(mark, transform), BRAND.accent);
	drawShapes(canvas, transformShapes(wordmark, transform), BRAND.ink);
	const caption = 'CLIENT';
	const tracking = 4;
	const captionX = Math.round((width - captionWidth(caption, 1, tracking)) / 2) + 1;
	drawCaption(canvas, caption, captionX, 40, { color: BRAND.headerCaption, tracking });
	fillRect(canvas, captionX - 12, 43, 8, 1, BRAND.accent);
	fillRect(canvas, captionX + captionWidth(caption, 1, tracking) + 3, 43, 8, 1, BRAND.accent);
	return canvas;
}
function renderSideBitmap() {
	const { width, height } = INSTALLER_ART_SIZES.side;
	const canvas = createCanvas(width, height, BRAND.panelTop);
	const panelTop = parseColor(BRAND.panelTop);
	const panelBottom = parseColor(BRAND.panelBottom);
	const washA = parseColor(BRAND.washA);
	const washB = parseColor(BRAND.washB);
	const washC = parseColor(BRAND.washC);
	paint(canvas, (_x, y) => {
		const vertical = y / (height - 1);
		return { color: mixColor(panelTop, panelBottom, vertical) };
	});
	const angle = (115 * Math.PI) / 180;
	const direction = { x: Math.sin(angle), y: -Math.cos(angle) };
	const extent = Math.abs(direction.x) * width + Math.abs(direction.y) * height;
	paint(canvas, (x, y) => {
		const t = clamp((x * direction.x + y * direction.y) / extent + 0.25, 0, 1);
		const color = t < 0.45 ? mixColor(washA, washB, t / 0.45) : mixColor(washB, washC, (t - 0.45) / 0.55);
		return { color, alpha: 0.07 };
	});
	fillRect(canvas, 0, 0, width, 3, BRAND.accent);
	fillRect(canvas, width - 1, 3, 1, height - 3, BRAND.rule);
	const markWidth = 76;
	const mark = fitToWidth(loadMarkShapes(), markWidth, (width - markWidth) / 2, 64);
	drawShapes(canvas, mark.shapes, BRAND.accent);
	const wordmarkWidth = 112;
	const wordmarkTop = 64 + mark.height + 26;
	const wordmark = fitToWidth(loadWordmarkShapes(), wordmarkWidth, (width - wordmarkWidth) / 2, wordmarkTop);
	drawShapes(canvas, wordmark.shapes, BRAND.white);
	const product = 'CLIENT';
	const productTracking = 6;
	const productX = Math.round((width - captionWidth(product, 1, productTracking)) / 2) + 2;
	drawCaption(canvas, product, productX, Math.round(wordmarkTop + wordmark.height + 14), {
		color: BRAND.accent,
		tracking: productTracking
	});
	fillRect(canvas, 28, 268, width - 56, 1, BRAND.rule);
	const footer = 'WOK.SOCIAL';
	const footerTracking = 2;
	const footerX = Math.round((width - captionWidth(footer, 1, footerTracking)) / 2) + 1;
	drawCaption(canvas, footer, footerX, 282, { color: BRAND.muted, tracking: footerTracking });
	return canvas;
}
export function renderInstallerArt() {
	return new Map([
		[INSTALLER_ART_FILES.header, encodeBmp24(renderHeaderBitmap())],
		[INSTALLER_ART_FILES.side, encodeBmp24(renderSideBitmap())]
	]);
}
export function writeInstallerArt() {
	mkdirSync(INSTALLER_ART_DIR, { recursive: true });
	const written = [];
	for (const [name, bytes] of renderInstallerArt()) {
		const target = join(INSTALLER_ART_DIR, name);
		writeFileSync(target, bytes);
		written.push(target);
	}
	return written;
}
function main() {
	const check = process.argv.includes('--check');
	const rendered = renderInstallerArt();
	if (!check) {
		for (const path of writeInstallerArt()) console.log(`Wrote ${path}`);
		return;
	}
	const stale = [];
	for (const [name, bytes] of rendered) {
		const target = join(INSTALLER_ART_DIR, name);
		let committed;
		try {
			committed = readFileSync(target);
		} catch {
			stale.push(`${name} is missing`);
			continue;
		}
		if (!committed.equals(bytes)) stale.push(`${name} does not match the generator output`);
	}
	if (stale.length > 0) {
		console.error(`Installer artwork is stale:\n  ${stale.join('\n  ')}`);
		console.error('Run: node scripts/generate-installer-art.mjs');
		process.exitCode = 1;
		return;
	}
	console.log('Installer artwork matches the committed bitmaps.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
