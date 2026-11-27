'use strict';
/* Code highlighting for the chat: a small tokenizer per kind of language, no library (the app works
   offline). It escapes every piece of text itself, so what it returns can go into innerHTML. Token
   classes: c comment, s string, n number, k keyword, b command/builtin, v variable, f function,
   p key/property, t tag, a attribute, ad/dl added/removed line. */
(function (root) {
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

	const STR_D = /"(?:\\[\s\S]|[^"\\\n])*"?/.source;
	const STR_S = /'(?:\\[\s\S]|[^'\\\n])*'?/.source;
	const STR_B = /`(?:\\[\s\S]|[^`\\])*`?/.source;
	const NUM = /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/.source;
	const BLOCK = /\/\*[\s\S]*?(?:\*\/|$)/.source;
	const SLASH = /\/\/[^\n]*/.source;
	const HASH = /(?:^|(?<=[\s;]))#[^\n]*/.source;

	// rules: [class, source] in order; then words, which keyword sets sort out.
	const LANGS = {
		sh: {
			rules: [['c', HASH], ['s', STR_D], ['s', /'[^']*'?/.source], ['v', /\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[?#@*$!0-9-]/.source], ['n', NUM]],
			word: /[A-Za-z_][\w.-]*/.source,
			kw: words('if then else elif fi for while until do done case esac in function return export local readonly declare unset shift exit break continue source alias set trap eval exec time select'),
			b: words('echo printf cd ls cat grep egrep rg sed awk find xargs sort uniq head tail wc cut tr tee chmod chown mkdir rmdir rm cp mv ln touch ps kill pkill killall top df du free mount umount tar gzip unzip zip curl wget ssh scp git python python3 pip pip3 node npm npx apt apt-get dpkg sudo su adb pm am cmd dumpsys settings getprop setprop logcat svc input screencap screenrecord uiautomator monkey wm content appops droid ashell pdata clip frida jadx r2 sqlite3 stat file which test true false sleep date env export read'),
			flag: true,
		},
		js: {
			rules: [['c', BLOCK], ['c', SLASH], ['s', STR_D], ['s', STR_S], ['s', STR_B], ['n', NUM]],
			word: /[A-Za-z_$][\w$]*/.source,
			kw: words('const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this import export from as async await yield try catch finally throw null undefined true false void static get set interface type enum implements private public protected readonly declare namespace keyof'),
			fn: true,
		},
		py: {
			rules: [['s', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/.source], ['c', /#[^\n]*/.source], ['s', /[rbfu]{0,2}(?:"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)/.source], ['n', NUM]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal assert del True False None async await match case'),
			b: words('print len range open str int float list dict set tuple bool type isinstance enumerate zip map filter sorted sum min max abs any all self super input'),
			fn: true,
		},
		json: {
			rules: [['p', /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/.source], ['s', STR_D], ['n', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/.source]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('true false null'),
		},
		c: {
			rules: [['c', BLOCK], ['c', SLASH], ['k', /^\s*#\s*\w+/.source], ['s', STR_D], ['s', /'(?:\\[\s\S]|[^'\\\n])'/.source], ['n', NUM]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('int char float double long short unsigned signed void bool boolean byte struct union enum typedef const static extern inline return if else for while do switch case default break continue goto sizeof public private protected class new delete this namespace using template typename virtual override final package import interface extends implements throws throw try catch finally val var fun object when is null true false nullptr auto suspend data sealed companion lateinit internal open abstract synchronized volatile transient native instanceof super'),
			fn: true,
		},
		go: {
			rules: [['c', BLOCK], ['c', SLASH], ['s', STR_D], ['s', STR_B], ['s', /'(?:\\[\s\S]|[^'\\\n])'/.source], ['n', NUM]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('func package import var const type struct interface map chan go defer select range return if else for switch case default break continue goto fallthrough nil true false iota make new len cap append panic recover error string int int64 uint byte rune bool float64'),
			fn: true,
		},
		rust: {
			rules: [['c', BLOCK], ['c', SLASH], ['s', STR_D], ['n', NUM]],
			word: /[A-Za-z_]\w*!?/.source,
			kw: words('fn let mut pub impl trait struct enum match use mod crate self Self super where loop as ref move dyn unsafe async await return if else for while in break continue const static type true false Some None Ok Err Box Vec String Option Result'),
			fn: true,
		},
		yaml: {
			rules: [['c', /(?:^|(?<=\s))#[^\n]*/.source], ['p', /^[ \t-]*[\w.-]+(?=\s*[:=])/.source], ['s', STR_D], ['s', STR_S], ['n', NUM]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('true false null yes no on off'),
		},
		sql: {
			rules: [['c', /--[^\n]*/.source], ['c', BLOCK], ['s', STR_S], ['s', STR_D], ['n', NUM]],
			word: /[A-Za-z_]\w*/.source,
			kw: words('select from where and or not insert into values update set delete create table drop alter add index primary key foreign references join left right inner outer on group by order having limit offset as distinct count sum avg min max null is in like between union all exists case when then else end begin commit rollback pragma'),
			ci: true,
		},
	};
	const ALIAS = {
		bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh', sh: 'sh', '': '',
		javascript: 'js', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js',
		python: 'py', py: 'py', python3: 'py',
		json: 'json', jsonc: 'json', json5: 'json',
		c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', java: 'c', kotlin: 'c', kt: 'c', kts: 'c', swift: 'c', cs: 'c', csharp: 'c', smali: 'c',
		go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
		yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', properties: 'yaml', env: 'yaml',
		sql: 'sql', sqlite: 'sql',
		xml: 'xml', html: 'xml', svg: 'xml', htm: 'xml', vue: 'xml',
		diff: 'diff', patch: 'diff',
	};
	const compiled = {};
	function re(name) {
		if (compiled[name]) return compiled[name];
		const L = LANGS[name];
		const parts = [...L.rules.map(([, src]) => src), L.word];
		compiled[name] = { L, re: new RegExp(parts.map((p) => `(${p})`).join('|'), 'gm') };
		return compiled[name];
	}
	const span = (cls, text) => `<span class="hl-${cls}">${esc(text)}</span>`;

	function tokens(name, code) {
		const { L, re: R } = re(name);
		let out = '', last = 0, m;
		R.lastIndex = 0;
		while ((m = R.exec(code))) {
			if (m[0] === '') { R.lastIndex++; continue; }
			out += esc(code.slice(last, m.index));
			last = m.index + m[0].length;
			const g = m.findIndex((x, i) => i > 0 && x !== undefined);
			if (g <= L.rules.length) { out += span(L.rules[g - 1][0], m[0]); continue; }
			// a word: a keyword, a command, a function being called, a flag — or plain text
			const w = m[0], key = L.ci ? w.toLowerCase() : w;
			const next = code.slice(last).match(/^\s*\(/);
			if (L.kw?.has(key)) out += span('k', w);
			else if (L.b?.has(w)) out += span('b', w);
			else if (L.fn && next) out += span('f', w);
			else out += esc(w);
		}
		return out + esc(code.slice(last));
	}
	// Flags in shell commands (-x, --long): after a space only, so a-b-c stays one word; not inside a
	// string or a comment already marked.
	const flags = (html) => html.split(/(<span[^>]*>[\s\S]*?<\/span>)/).map((part, i) => (i % 2 ? part
		: part.replace(/(^|\s)(--?[A-Za-z][\w-]*)/g, '$1<span class="hl-a">$2</span>'))).join('');

	function xml(code) {
		let out = '', last = 0, m;
		const R = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:.-]*(?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>?/g;
		while ((m = R.exec(code))) {
			out += esc(code.slice(last, m.index));
			last = m.index + m[0].length;
			if (m[0].startsWith('<!--')) { out += span('c', m[0]); continue; }
			const t = /^(<\/?)([\w:.-]+)([\s\S]*?)(\/?>)?$/.exec(m[0]);
			if (!t) { out += esc(m[0]); continue; }
			const attrs = t[3].replace(/([^\s=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s>]+)?/g, (a, n, eq, v) =>
				`\u0001a${n}\u0002${eq ? esc(eq) : ''}${v ? `\u0001s${v}\u0002` : ''}`);
			out += esc(t[1]) + span('t', t[2]) + esc(attrs).replace(/\u0001([as])([^\u0002]*)\u0002/g, (_, c, v) => `<span class="hl-${c}">${v}</span>`) + esc(t[4] || '');
		}
		return out + esc(code.slice(last));
	}

	function diff(code) {
		return code.split('\n').map((l) => (/^\+(?!\+\+)/.test(l) ? span('ad', l) : /^-(?!--)/.test(l) ? span('dl', l) : /^@@/.test(l) ? span('k', l) : esc(l))).join('\n');
	}

	// The language a block names, or a guess from what it looks like; '' for plain text.
	function langOf(lang, code) {
		const l = String(lang || '').toLowerCase().trim();
		if (l in ALIAS) return ALIAS[l] || guess(code);
		return l ? '' : guess(code);
	}
	function guess(code) {
		const s = String(code).trim();
		if (/^[{[][\s\S]*[}\]]$/.test(s) && /"\s*:/.test(s)) return 'json';
		if (/^<[!?A-Za-z]/.test(s)) return 'xml';
		if (/^(?:diff --git|---\s|\+\+\+\s|@@)/m.test(s) && /^[+-]/m.test(s)) return 'diff';
		if (/^(?:#!.*\b(?:sh|bash)\b|\$ |(?:sudo |adb |pm |am |cd |ls |cat |echo |grep |dumpsys |su ))/m.test(s)) return 'sh';
		if (/^(?:def |import |from \S+ import |class \w+[(:])/m.test(s)) return 'py';
		if (/^(?:const |let |function |import .* from |export )/m.test(s)) return 'js';
		return '';
	}

	function highlight(lang, code) {
		const name = langOf(lang, code);
		if (!name) return esc(code);
		if (name === 'xml') return xml(code);
		if (name === 'diff') return diff(code);
		const html = tokens(name, code);
		return LANGS[name].flag ? flags(html) : html;
	}

	const api = { highlight, langOf };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.DA_HL = api;
})(typeof window !== 'undefined' ? window : globalThis);
