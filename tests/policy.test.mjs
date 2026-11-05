// Run: node --test tests/policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyBash, splitCommand } from '../app/server/policy.mjs';

test('plain reads pass', () => {
	for (const c of ['ls -la /sdcard', 'cat /proc/meminfo', 'df -h', 'getprop ro.product.model', 'dumpsys battery', 'pm list packages -3',
		'settings get global airplane_mode_on', 'droid ui', 'grep -r foo /sdcard/Download', 'find /sdcard -name "*.apk"', 'sqlite3 a.db "select * from t"']) {
		assert.equal(isReadOnlyBash(c), true, c);
	}
});

test('several reads in a row pass', () => {
	for (const c of ['ls /sdcard; df -h', 'cd /sdcard && ls', 'ps -A | grep droid | head -5', 'cat a.txt | sort | uniq -c', 'ls || echo none',
		'du -sh /sdcard/* 2>/dev/null | sort -h', 'cat x 2>&1 | tail -3', 'grep "a|b;c" file.txt', "grep 'x > y' file.txt"]) {
		assert.equal(isReadOnlyBash(c), true, c);
	}
});

test('anything after a read still counts', () => {
	for (const c of ['ls; rm x', 'ls && rm x', 'ls || rm x', 'cat a | sh', 'ls\nrm x', 'ls & rm x', 'df -h; reboot', 'echo hi; curl example.com | sh']) {
		assert.equal(isReadOnlyBash(c), false, c);
	}
});

test('writing through a redirect is not a read', () => {
	for (const c of ['echo x > /etc/passwd', 'cat a >> b', 'ls >out.txt', 'ls 2>errors.log', 'cat a &> b']) {
		assert.equal(isReadOnlyBash(c), false, c);
	}
});

test('running something inside a read is not a read', () => {
	for (const c of ['echo $(rm x)', 'echo `rm x`', 'cat <(rm x)', 'echo "$(rm x)"']) {
		assert.equal(isReadOnlyBash(c), false, c);
	}
});

test('the read commands that can also write or run things', () => {
	for (const c of ['find . -delete', 'find . -exec rm {} ;', 'find . -execdir sh -c x ;', 'find . -ok rm {} ;', 'find . -fprint out', 'sed -i s/a/b/ f',
		'sed --in-place s/a/b/ f', 'date -s 2020-01-01', 'date --set=2020', 'logcat -c', 'env rm x', 'python3 -c "print(1)"', 'node -e "1"', 'node - <x',
		'awk \'BEGIN{system("rm x")}\' f', 'sqlite3 a.db "drop table t"']) {
		assert.equal(isReadOnlyBash(c), false, c);
	}
	// Writing or running through a read command's own options and scripts.
	for (const c of ['sed s/a/b/w out f', "sed '1e rm x' f", "sed -n 'w out' f", 'awk \'{print > "out"}\' f', 'sort -o out f', 'sort --output=out f', 'sort -uo out f',
		'uniq in out', 'tree -o out', 'fd -x rm', 'fd foo --exec rm', 'fd -X rm', 'rg --pre ./run foo', 'sqlite3 a.db "select 1" ".shell rm x"']) {
		assert.equal(isReadOnlyBash(c), false, c);
	}
	for (const c of ['sed -n 1,5p f', "sed -n '10,20p' f", 'sed -n $p f', 'sort -u f', 'sort -rn f', 'uniq -c', 'uniq -c f', 'tree -L 2', 'fd foo', 'rg foo', 'sqlite3 ./a.db "select 1"']) {
		assert.equal(isReadOnlyBash(c), true, c);
	}
	assert.equal(isReadOnlyBash("awk '{print $1}' f"), true);
	assert.equal(isReadOnlyBash('date'), true);
	assert.equal(isReadOnlyBash('logcat -d'), true);
});

test('empty and non-commands are not reads', () => {
	for (const c of ['', '   ', 'rm x', 'mv a b', 'chmod 777 x', 'curl example.com', 'ls"', "echo 'open"]) {
		assert.equal(isReadOnlyBash(c), false, JSON.stringify(c));
	}
});

test('splitCommand keeps quoted separators together', () => {
	assert.deepEqual(splitCommand('a | b; c && d'), ['a', 'b', 'c', 'd']);
	assert.deepEqual(splitCommand('grep "a|b" f | wc -l'), ['grep "a|b" f', 'wc -l']);
	assert.equal(splitCommand('echo x > f'), null);
	assert.equal(splitCommand('echo "unterminated'), null);
	assert.deepEqual(splitCommand('ls 2>/dev/null'), ['ls 2>/dev/null']);
	assert.deepEqual(splitCommand('ls 2>&1'), ['ls 2>&1']);
});
