#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { accessSync, constants, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
const definitions = [
    ['zsh', 'Shell', 'Zsh interactive shell'],
    ['starship', 'Shell', 'Starship prompt'],
    ['zoxide', 'Shell', 'Directory jumper replacing cd'],
    ['fzf', 'Terminal', 'Fuzzy finder and shell integration'],
    ['fd', 'Terminal', 'Fast find replacement'],
    ['eza', 'Terminal', 'ls replacement'],
    ['bat', 'Terminal', 'cat replacement'],
    ['ripgrep', 'Terminal', 'Fast text search'],
    ['tmux', 'Terminal', 'Persistent terminal sessions'],
    ['xclip', 'Clipboard', 'X11 clipboard helper'],
    ['wl-clipboard', 'Clipboard', 'Wayland clipboard helper'],
    ['cloc', 'Developer', 'Count source lines'],
    ['mise', 'Developer', 'Runtime version manager'],
    ['node', 'Developer', 'Node.js runtime, required by this wizard'],
    ['bun', 'Developer', 'JavaScript runtime and package manager'],
    ['git-lfs', 'Developer', 'Git large-file support'],
    ['pipx', 'Developer', 'Isolated Python command-line tools'],
    ['ruby', 'Developer', 'Ruby runtime'],
    ['graphviz', 'Developer', 'Render diagrams'],
    ['unison', 'Developer', 'File synchronization'],
    ['tlrc', 'Developer', 'tldr command-line help'],
    ['ruff', 'Developer', 'Python linting and formatting'],
    ['rust-analyzer', 'Developer', 'Rust language server'],
    ['basedpyright', 'Developer', 'Python language server'],
    ['typescript-language-server', 'Developer', 'TypeScript and JavaScript language server'],
    ['vscode-langservers-extracted', 'Developer', 'HTML, CSS, JSON, and ESLint language servers'],
    ['omp', 'Agent tools', 'Oh My Pi coding agent'],
    ['herdr', 'Agent tools', 'Agent multiplexer'],
    ['pi', 'Agent tools', 'Pi coding agent'],
    ['vscode', 'Desktop', 'Visual Studio Code'],
    ['ghostty', 'Desktop', 'Ghostty terminal emulator'],
    ['font-fira-mono', 'Desktop', 'FiraMono Nerd Font'],
    ['alt-tab', 'Desktop', 'AltTab window switcher'],
    ['iterm2', 'Desktop', 'iTerm2 terminal'],
    ['obs', 'Desktop', 'OBS screen recording'],
    ['ollama', 'Local AI', 'Ollama and nomic-embed-text model'],
];
const stowPackages = [
    ['agents', 'Shared agent instructions'],
    ['codex', 'Codex settings'],
    ['ghostty', 'Ghostty configuration'],
    ['herdr', 'Herdr configuration'],
    ['omp', 'OMP configuration'],
    ['pi', 'Pi configuration'],
    ['pi-ollama', 'Pi local-search configuration'],
    ['starship', 'Starship prompt configuration'],
    ['tmux', 'tmux configuration'],
    ['zsh', 'Zsh aliases, bindings, plugins, and history settings'],
];
const unsupported = {
    ubuntu: { 'alt-tab': true, iterm2: true, obs: true, tlrc: true },
    darwin: { xclip: true, 'wl-clipboard': true },
};
const serverStow = ['agents', 'codex', 'herdr', 'omp', 'pi', 'pi-ollama', 'starship', 'tmux', 'zsh'];
const desktopPackages = {
    vscode: true, ghostty: true, 'font-fira-mono': true, 'alt-tab': true, iterm2: true, obs: true, xclip: true, 'wl-clipboard': true,
};
const stages = ['profile', 'software', 'configs', 'shell', 'review'];
function argsFrom(argv) {
    const args = new Map();
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i];
        const value = argv[i + 1];
        if (!key || !['--platform', '--result-file', '--installer'].includes(key) || !value || value.startsWith('--') || args.has(key)) {
            throw new Error(`Unexpected, duplicate, or incomplete argument: ${key ?? ''}`);
        }
        args.set(key, value);
    }
    const platform = args.get('--platform');
    if (platform !== 'ubuntu' && platform !== 'darwin')
        throw new Error('--platform must be ubuntu or darwin.');
    const resultFile = args.get('--result-file');
    if (!resultFile)
        throw new Error('--result-file is required.');
    const installer = args.get('--installer');
    if (!installer || !isAbsolute(installer))
        throw new Error('--installer must be an absolute installer file path.');
    if (!statSync(installer).isFile())
        throw new Error('--installer must name a file.');
    accessSync(installer, constants.R_OK);
    return { platform, installer, resultFile: resolve(resultFile) };
}
function configAvailable(name, packages) {
    if (name === 'pi-ollama')
        return packages.has('pi') && packages.has('ollama');
    if (['ghostty', 'herdr', 'omp', 'pi'].includes(name))
        return packages.has(name);
    return true;
}
function wrap(text, width) {
    const cleaned = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, '    ');
    return cleaned.split('\n').flatMap((line) => {
        const lines = [];
        let remaining = Array.from(line);
        while (remaining.length > width) {
            const space = remaining.slice(0, width + 1).lastIndexOf(' ');
            const end = space > width / 2 ? space : width;
            lines.push(remaining.slice(0, end).join(''));
            remaining = remaining.slice(end + (remaining[end] === ' ' ? 1 : 0));
        }
        lines.push(remaining.join(''));
        return lines;
    });
}
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const useColor = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const style = (code, text) => useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const muted = (text) => style(2, text);
const accent = (text) => style(36, text);
const bold = (text) => style(1, text);
const success = (text) => style(32, text);
const focus = (text) => accent(style(4, bold(text)));
const sectionHeadings = {
    'Installation review': true,
    'Software and dependencies': true,
    'Stow sources and account targets': true,
    'Shared shell hooks and account changes': true,
    'Wizard bootstrap and cleanup': true,
};
function clip(text, width) {
    if (Array.from(text.replace(ansi, '')).length <= width)
        return text;
    let remaining = width;
    let clipped = '';
    for (const part of text.split(/(\u001b\[[0-?]*[ -/]*[@-~])/)) {
        if (part.startsWith('\u001b'))
            clipped += part;
        else {
            const characters = Array.from(part).slice(0, remaining);
            clipped += characters.join('');
            remaining -= characters.length;
            if (remaining === 0)
                break;
        }
    }
    return `${clipped}${useColor ? '\u001b[0m' : ''}`;
}
function saveResult(path, result) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
        renameSync(temporaryPath, path);
    }
    catch (error) {
        try {
            unlinkSync(temporaryPath);
        }
        catch { /* The temporary file may not exist. */ }
        throw error;
    }
}
async function runWizard(args) {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || !output.isTTY)
        throw new Error('The setup wizard needs an interactive terminal.');
    const makeDraft = (profile) => ({
        packages: new Set(definitions.filter(([id]) => !unsupported[args.platform][id]
            && (profile === 'personal' || !desktopPackages[id] && id !== 'ollama')).map(([id]) => id)),
        stow: new Set(profile === 'personal' ? stowPackages.map(([id]) => id) : serverStow),
        setLoginShell: true,
    });
    const drafts = { personal: makeDraft('personal'), server: makeDraft('server') };
    let profile = args.platform === 'ubuntu' ? 'server' : 'personal';
    let stage = 'profile';
    let cursor = profile === 'personal' ? 0 : 1;
    let returnToReview = false;
    let plan = '';
    let planError = '';
    let planOffset = 0;
    let planHeight = 1;
    let planLines = [];
    const groups = [];
    for (const [value, name, label] of definitions) {
        let group = groups.find((candidate) => candidate.name === name);
        if (!group) {
            group = { name, expanded: name === 'Shell', items: [] };
            groups.push(group);
        }
        const disabled = unsupported[args.platform][value] === true;
        group.items.push({ value, label, disabled, hint: disabled ? 'Unavailable on this platform' : value === 'node' ? 'required' : '' });
    }
    const draft = () => drafts[profile];
    const result = () => ({
        profile,
        packages: definitions.filter(([id]) => draft().packages.has(id) && !unsupported[args.platform][id]).map(([id]) => id),
        stow: stowPackages.filter(([id]) => draft().stow.has(id) && configAvailable(id, draft().packages)).map(([id]) => id),
        setLoginShell: draft().packages.has('zsh') && draft().setLoginShell,
    });
    const loadPlan = () => {
        const selection = result();
        try {
            plan = execFileSync('bash', [args.installer, '--review-plan', args.platform, selection.profile,
                selection.packages.join(' '), selection.stow.join(' '), selection.setLoginShell ? '1' : '0'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
            if (!plan.trim())
                throw new Error('The installer returned an empty plan.');
            planError = '';
            return true;
        }
        catch (error) {
            let detail = error instanceof Error ? error.message : String(error);
            if (error instanceof Error && 'stderr' in error) {
                const stderr = error.stderr;
                if (typeof stderr === 'string' || Buffer.isBuffer(stderr))
                    detail = stderr.toString().trim() || detail;
            }
            plan = '';
            planError = `Plan unavailable. Installation is blocked.\n${detail}`;
            return false;
        }
    };
    const rows = () => stage === 'software'
        ? [{ type: 'all' }, ...groups.flatMap((group) => [
                { type: 'group', group }, ...(group.expanded ? group.items.map((item) => ({ type: 'item', item, group })) : []),
            ])]
        : [{ type: 'all' }, ...stowPackages.map(([value, label]) => ({ type: 'item', item: {
                    value, label, disabled: !configAvailable(value, draft().packages), hint: configAvailable(value, draft().packages) ? '' : 'Requires selected software',
                } }))];
    const box = (items, selected) => {
        const available = items.filter((item) => !item.disabled);
        const count = available.filter((item) => selected.has(item.value)).length;
        return count === 0 ? '○' : count === available.length ? success('●') : success('◐');
    };
    const reviewActions = ['Edit profile', 'Edit software', 'Edit configs', 'Edit login shell', 'Install', 'Cancel'];
    const moveTo = (next) => {
        stage = next;
        cursor = next === 'profile' ? (profile === 'personal' ? 0 : 1)
            : next === 'shell' ? (draft().setLoginShell && draft().packages.has('zsh') ? 0 : 1) : 0;
        if (next === 'review') {
            planOffset = 0;
            loadPlan();
        }
    };
    const forward = () => {
        if (stage === 'profile') {
            profile = cursor === 0 ? 'personal' : 'server';
            returnToReview = false;
            moveTo('software');
        }
        else if (returnToReview) {
            returnToReview = false;
            moveTo('review');
        }
        else {
            const next = stages[stages.indexOf(stage) + 1];
            if (next)
                moveTo(next);
        }
    };
    const back = () => {
        if (stage === 'profile' && returnToReview) {
            returnToReview = false;
            moveTo('review');
            return;
        }
        const previous = stages[stages.indexOf(stage) - 1];
        if (previous)
            moveTo(previous);
    };
    const render = () => {
        const width = Math.max(1, Math.min(100, (output.columns || 80) - 1));
        const innerWidth = Math.max(1, width - 4);
        const height = Math.max(1, output.rows || 24);
        const step = stages.indexOf(stage);
        const labels = ['Profile', 'Software', 'Configs', 'Shell', 'Review'];
        const title = {
            profile: 'Choose a starting profile', software: 'Select software to install', configs: 'Select dotfile configs',
            shell: 'Choose login shell', review: 'Review installation',
        };
        const rail = (text = '') => `${muted('│')}  ${text}`;
        const progress = labels.map((label, index) => index === step ? focus(`◆ ${label}`)
            : index < step ? success(`✓ ${label}`) : muted(`○ ${label}`)).join(muted(' › '));
        const header = [
            `${muted('┌')}  ${bold('Dotfiles setup')}  ${muted(`${args.platform === 'ubuntu' ? 'Ubuntu' : 'macOS'} · ${profile === 'personal' ? 'Personal' : 'Server'} draft`)}`,
            ...(height >= 22 ? [rail()] : []),
            rail(Array.from(progress.replace(ansi, '')).length <= innerWidth ? progress : focus(`Step ${step + 1} of 5 · ${labels[step]}`)),
            ...(height >= 22 ? [rail()] : []),
            `${accent('◆')}  ${bold(title[stage])} ${muted(`· ${step + 1}/5`)}`,
            rail(),
        ];
        const controls = stage === 'review'
            ? '↑↓/Tab actions · Enter choose · Shift+Tab back · Ctrl+C cancel'
            : stage === 'software' || stage === 'configs'
                ? `↑↓ move${stage === 'software' ? ' · ←→ groups' : ''} · Space toggle · Tab next · Shift+Tab back · Ctrl+C cancel`
                : `↑↓ choose · Tab/Enter next${stage !== 'profile' || returnToReview ? ' · Shift+Tab back' : ''} · Ctrl+C cancel`;
        const hints = wrap(controls, innerWidth);
        const footer = [rail(), ...hints.map((hint, index) => `${muted(index === 0 ? '└' : ' ')}  ${muted(hint)}`)];
        const budget = Math.max(1, height - header.length - footer.length);
        const pointer = (active) => active ? accent('›') : ' ';
        const name = (text, active) => active ? focus(text) : bold(text);
        let body;
        if (stage === 'review') {
            const selection = result();
            const summary = wrap(`Software ${selection.packages.length} · Configs ${selection.stow.length} · Login shell ${selection.setLoginShell ? 'Zsh' : 'unchanged'}`, innerWidth);
            let actions = reviewActions.map((label, index) => rail(`${pointer(index === cursor)} ${index === cursor ? focus(label) : index === 4 ? success(bold(label)) : label}${index === 4 && planError ? style(31, ' [blocked]') : ''}`));
            if (budget - summary.length - actions.length - 3 < 6) {
                actions = [rail(`${pointer(true)} ${focus(reviewActions[cursor] ?? '')}${cursor === 4 && planError ? style(31, ' [blocked]') : ''} ${muted(`· action ${cursor + 1}/${reviewActions.length}`)}`)];
            }
            planHeight = Math.max(1, budget - summary.length - actions.length - 3);
            planLines = wrap(planError || plan, Math.max(1, innerWidth - 2));
            planOffset = Math.max(0, Math.min(planOffset, planLines.length - planHeight));
            const visiblePlan = Array.from({ length: planHeight }, (_, i) => {
                const text = planLines[planOffset + i] ?? '';
                return rail(`${muted('│')} ${planError ? style(31, text) : sectionHeadings[text] ? bold(text) : text}`);
            });
            body = [
                ...summary.map((text) => rail(muted(text))),
                rail(muted(`╭─ Install plan · lines ${planOffset + 1}–${Math.min(planOffset + planHeight, planLines.length)} / ${planLines.length}`)),
                ...visiblePlan,
                rail(muted('╰─ PgUp/PgDn scroll · Home/End jump')),
                rail(),
                ...actions,
            ];
        }
        else if (stage === 'profile') {
            body = [
                rail(`${pointer(cursor === 0)} ${cursor === 0 ? accent('●') : muted('○')} ${name('Personal', cursor === 0)}  ${muted('Full personal toolset and configs')}`),
                rail(`${pointer(cursor === 1)} ${cursor === 1 ? accent('●') : muted('○')} ${name('Server', cursor === 1)}  ${muted('CLI tools; desktop and local AI off')}`),
                rail(),
                ...wrap('Start with a preset, then add or remove individual packages.', innerWidth).map((text) => rail(muted(text))),
                ...wrap('Each profile keeps its own edits for this session.', innerWidth).map((text) => rail(muted(text))),
            ];
        }
        else if (stage === 'shell') {
            body = draft().packages.has('zsh') ? [
                rail(`${pointer(cursor === 0)} ${draft().setLoginShell ? success('●') : muted('○')} ${name('Yes', cursor === 0)}  ${muted("Set Zsh as this account's login shell")}`),
                rail(`${pointer(cursor === 1)} ${draft().setLoginShell ? muted('○') : success('●')} ${name('No', cursor === 1)}  ${muted('Leave the login shell unchanged')}`),
                rail(),
                ...wrap('The change takes effect after logging out and back in.', innerWidth).map((text) => rail(muted(text))),
            ] : [
                rail(`${muted('○')} ${bold('Leave the login shell unchanged')}`),
                rail(),
                ...wrap('Zsh is not selected. Your previous shell preference stays in this draft.', innerWidth).map((text) => rail(muted(text))),
            ];
        }
        else {
            const entries = rows();
            cursor = Math.max(0, Math.min(cursor, entries.length - 1));
            const selected = stage === 'software' ? draft().packages : draft().stow;
            const allItems = stage === 'software' ? groups.flatMap((group) => group.items)
                : entries.flatMap((entry) => entry.type === 'item' ? [entry.item] : []);
            const available = allItems.filter((item) => !item.disabled);
            const current = entries[cursor];
            const description = current?.type === 'all'
                ? `Select or clear all ${available.length} available ${stage === 'software' ? 'packages. Node stays selected.' : 'configs.'}`
                : current?.type === 'group'
                    ? `Select or clear every available package in ${current.group.name}.`
                    : current?.type === 'item' ? `${current.item.label}${current.item.hint ? `. ${current.item.hint}.` : ''}` : '';
            const details = height >= 24
                ? [rail(), rail(muted('Description')), ...wrap(description, innerWidth).map((text) => rail(muted(text)))]
                : [];
            const visibleHeight = Math.max(1, budget - details.length - 1);
            const start = Math.max(0, Math.min(entries.length - visibleHeight, cursor - Math.floor(visibleHeight / 2)));
            body = entries.slice(start, start + visibleHeight).map((entry, index) => {
                const active = index + start === cursor;
                if (entry.type === 'all')
                    return rail(`${pointer(active)} ${box(allItems, selected)} ${name('Select all', active)} ${muted(`${available.filter((item) => selected.has(item.value)).length}/${available.length}`)}`);
                if (entry.type === 'group') {
                    const items = entry.group.items.filter((item) => !item.disabled);
                    const count = items.filter((item) => selected.has(item.value)).length;
                    return rail(`${pointer(active)} ${muted(entry.group.expanded ? '▾' : '▸')} ${box(entry.group.items, selected)} ${name(entry.group.name, active)} ${muted(`${count}/${items.length}`)}`);
                }
                const item = entry.item;
                const tree = entry.group ? `${muted(entry.group.items.at(-1) === item ? '└─' : '├─')} ` : '';
                const marker = item.disabled ? muted('·') : selected.has(item.value) ? success('●') : muted('○');
                return rail(`${pointer(active)} ${tree}${marker} ${item.disabled ? muted(item.value) : name(item.value, active)}  ${muted(item.disabled ? item.hint : item.label)}`);
            });
            if (start > 0 || start + visibleHeight < entries.length) {
                body.push(rail(muted(`${start > 0 ? '↑ more above' : ''}${start > 0 && start + visibleHeight < entries.length ? ' · ' : ''}${start + visibleHeight < entries.length ? '↓ more below' : ''}`)));
            }
            body.push(...details);
        }
        const lines = [...header, ...body.slice(0, budget), ...footer];
        output.write(`\u001b[H\u001b[2J${lines.slice(0, height).map((text) => clip(text, width)).join('\n')}`);
    };
    return new Promise((resolvePromise, reject) => {
        const originalRawMode = input.isRaw;
        let finished = false;
        const finish = (accepted, error) => {
            if (finished)
                return;
            finished = true;
            input.off('keypress', onKeypress);
            input.off('end', onEnd);
            input.off('error', onError);
            output.off('resize', onResize);
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
            process.off('SIGHUP', onSignal);
            try {
                input.setRawMode(originalRawMode);
            }
            catch { /* The terminal may have closed. */ }
            input.pause();
            output.write('\u001b[?25h\n');
            if (error !== undefined)
                reject(error);
            else
                resolvePromise(accepted);
        };
        const onEnd = () => finish(false);
        const onError = (error) => finish(false, error);
        const onSignal = () => finish(false);
        const onResize = () => {
            try {
                render();
            }
            catch (error) {
                finish(false, error);
            }
        };
        const onKeypress = (character, key = {}) => {
            try {
                if (finished)
                    return;
                if (key.ctrl && (key.name === 'c' || key.name === 'd') || key.name === 'escape')
                    return finish(false);
                if (key.name === 'tab' && key.shift) {
                    back();
                    render();
                    return;
                }
                if (stage === 'review') {
                    if (key.name === 'up')
                        cursor = Math.max(0, cursor - 1);
                    else if (key.name === 'down')
                        cursor = Math.min(reviewActions.length - 1, cursor + 1);
                    else if (key.name === 'tab')
                        cursor = (cursor + 1) % reviewActions.length;
                    else if (key.name === 'pageup')
                        planOffset -= planHeight;
                    else if (key.name === 'pagedown')
                        planOffset += planHeight;
                    else if (key.name === 'home')
                        planOffset = 0;
                    else if (key.name === 'end')
                        planOffset = planLines.length;
                    else if (key.name === 'return' || key.name === 'enter') {
                        if (cursor === 5)
                            return finish(false);
                        if (cursor === 4) {
                            if (loadPlan()) {
                                saveResult(args.resultFile, result());
                                return finish(true);
                            }
                        }
                        else {
                            const target = stages[cursor];
                            if (target) {
                                returnToReview = true;
                                moveTo(target);
                            }
                        }
                    }
                    render();
                    return;
                }
                if (key.name === 'tab' || key.name === 'return' || key.name === 'enter') {
                    if (stage === 'shell' && draft().packages.has('zsh'))
                        draft().setLoginShell = cursor === 0;
                    forward();
                    render();
                    return;
                }
                if (stage === 'profile' || stage === 'shell') {
                    if (key.name === 'up')
                        cursor = 0;
                    else if (key.name === 'down')
                        cursor = 1;
                    else if (key.name === 'space' || character === ' ') {
                        if (stage === 'profile')
                            profile = cursor === 0 ? 'personal' : 'server';
                        else if (draft().packages.has('zsh'))
                            draft().setLoginShell = cursor === 0;
                    }
                    if (stage === 'shell' && draft().packages.has('zsh') && (key.name === 'up' || key.name === 'down')) {
                        draft().setLoginShell = cursor === 0;
                    }
                }
                else {
                    const entries = rows();
                    const row = entries[cursor];
                    if (key.name === 'up')
                        cursor = Math.max(0, cursor - 1);
                    else if (key.name === 'down')
                        cursor = Math.min(entries.length - 1, cursor + 1);
                    else if (key.name === 'right' && row?.type === 'group')
                        row.group.expanded = true;
                    else if (key.name === 'left' && row && 'group' in row && row.group) {
                        row.group.expanded = false;
                        cursor = entries.findIndex((entry) => entry.type === 'group' && entry.group === row.group);
                    }
                    else if (key.name === 'space' || character === ' ') {
                        const selected = stage === 'software' ? draft().packages : draft().stow;
                        const items = row?.type === 'all' ? (stage === 'software' ? groups.flatMap((group) => group.items)
                            : entries.flatMap((entry) => entry.type === 'item' ? [entry.item] : []))
                            : row?.type === 'group' ? row.group.items : row?.type === 'item' ? [row.item] : [];
                        const available = items.filter((item) => !item.disabled && !(stage === 'software' && item.value === 'node'));
                        const remove = available.length > 0 && available.every((item) => selected.has(item.value));
                        for (const item of available) {
                            if (remove)
                                selected.delete(item.value);
                            else
                                selected.add(item.value);
                        }
                    }
                }
                render();
            }
            catch (error) {
                finish(false, error);
            }
        };
        try {
            emitKeypressEvents(input);
            input.setRawMode(true);
            input.resume();
            input.on('keypress', onKeypress);
            input.on('end', onEnd);
            input.on('error', onError);
            output.on('resize', onResize);
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);
            process.on('SIGHUP', onSignal);
            output.write('\u001b[?25l');
            render();
        }
        catch (error) {
            finish(false, error);
        }
    });
}
async function main() {
    const accepted = await runWizard(argsFrom(process.argv));
    console.log(accepted ? 'Selections saved. Starting the approved installation.' : 'Cancelled. No install actions have started.');
    if (!accepted)
        process.exitCode = 130;
}
main().catch((error) => {
    console.error(`Wizard failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
