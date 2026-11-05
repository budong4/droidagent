// Is a shell command only looking? Ask mode and Plan mode run such commands without asking, so a
// wrong "yes" here runs something the owner meant to approve. When in doubt the answer is no: the
// worst a wrong "no" does is ask once more. No side effects, so it can be tested without a phone.

const READ_ONLY = /^(cd|ls|cat|head|tail|less|grep|egrep|rg|fd|find|stat|file|wc|echo|printf|pwd|df|du|free|ps|top|htop|id|whoami|uname|date|getprop|dumpsys|logcat|sort|uniq|cut|tr|nl|tac|rev|column|basename|dirname|realpath|readlink|sed|awk|pm\s+(list|path|dump)|cmd\s+\w+\s+(list|get|dump)|settings\s+get|input\s+keyevent\s+KEYCODE_(POWER|WAKEUP)|droid\s+(ui|shot|top|apps)|screencap|uiautomator\s+dump|sqlite3\s+\S+\s+["']?select|tree|which)(\s|$)/i;

// What these commands can do beyond reading.
const WRITES = [
	[/^find\s/i, /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(\s|$)/],
	// sed scripts can write (w) and run (e), so only printing a range of lines counts.
	[/^sed(\s|$)/i, /^(?!sed\s+-n\s+['"]?[\d,$]+p['"]?(\s|$))/i],
	[/^date\s/i, /\s(-s|--set)/],
	[/^logcat\s/i, /\s(-c|--clear|-f|--file)/],
	[/^awk\s/i, /system\s*\(|getline|\||>/],
	[/^sqlite3\s/i, /;.*\S|\s["']?\.\w/],
	[/^sort\s/i, /\s(-[a-z]*o|--output)/],
	[/^uniq\s/i, /^uniq(\s+-\S+)*(\s+[^-\s]\S*){2,}/], // a second file name is where it writes
	[/^tree\s/i, /\s-o(\s|$)/],
	[/^fd\s/i, /\s(-x|-X|--exec|--exec-batch)(\s|=|$)/],
	[/^rg\s/i, /\s--pre(\s|=|$)/],
];

// The commands joined by ; && || | or a new line, or null if it does anything else at the shell level:
// a redirect that writes somewhere, a background job, a command run inside another, an open quote.
export function splitCommand(cmd) {
	const s = String(cmd ?? '');
	const out = [];
	let cur = '';
	let quote = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote === "'") {
			if (c === "'") quote = '';
			cur += c;
			continue;
		}
		if (c === '\\') { cur += c + (s[++i] ?? ''); continue; }
		if (c === '`' || (c === '$' && s[i + 1] === '(')) return null; // works inside double quotes too
		if (quote === '"') {
			if (c === '"') quote = '';
			cur += c;
			continue;
		}
		if (c === "'" || c === '"') { quote = c; cur += c; continue; }
		if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue; }
		if (c === '|') { if (s[i + 1] === '|') i++; out.push(cur); cur = ''; continue; }
		if (c === '&') {
			if (s[i + 1] === '&') { i++; out.push(cur); cur = ''; continue; }
			return null;
		}
		if (c === '>') {
			// Only throwing output away, or joining stderr to stdout, leaves nothing behind.
			const rest = s.slice(i);
			const safe = /^>\s*\/dev\/null(?=\s|$|[;|&])/.exec(rest) || /^>&[12](?=\s|$|[;|&])/.exec(rest);
			if (!safe) return null;
			cur += safe[0];
			i += safe[0].length - 1;
			continue;
		}
		if (c === '<' && s[i + 1] === '(') return null;
		cur += c;
	}
	if (quote) return null;
	out.push(cur);
	return out.map((p) => p.trim()).filter(Boolean);
}

export function isReadOnlyBash(cmd) {
	const parts = splitCommand(cmd);
	if (!parts || !parts.length) return false;
	return parts.every((p) => READ_ONLY.test(p) && !WRITES.some(([which, how]) => which.test(p) && how.test(p)));
}
