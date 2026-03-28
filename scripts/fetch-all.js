import { spawn } from 'node:child_process';

const commands = [
	['node', './scripts/fetch-rss.js'],
	['node', './scripts/fetch-gdprhub.js'],
	['node', './scripts/fetch-enforcement.js'],
];

for (const [command, script] of commands) {
	await run(command, [script]);
}

async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			stdio: 'inherit',
		});

		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
		});

		child.on('error', reject);
	});
}
