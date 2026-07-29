import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
if (manifest.schemaVersion !== 'tutti.agent.manifest.v2' || manifest.agentKey !== 'hermes' || manifest.version !== '1.0.0') throw new Error('invalid manifest identity');
const expectedInstall = ['tool', 'install', 'hermes-agent[acp]==0.18.2'];
if (manifest.runtime?.kind !== 'standard-acp' || manifest.runtime.install?.runner !== 'uv' || JSON.stringify(manifest.runtime.install.args) !== JSON.stringify(expectedInstall)) throw new Error('Hermes runtime must use the pinned, isolated uv tool contract');
if (manifest.runtime.launch?.executable !== '${installRoot}/bin/hermes' || JSON.stringify(manifest.runtime.launch.args) !== JSON.stringify(['acp']) || manifest.runtime.launch.publishUserCommand !== false) throw new Error('Hermes managed launch contract changed');
const discovery = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.discovery), 'utf8'));
const candidate = discovery.candidates?.[0];
if (discovery.candidates?.length !== 1 || JSON.stringify(candidate.binaryNames) !== JSON.stringify(['hermes'])) throw new Error('Hermes discovery binary changed');
if (JSON.stringify(candidate.version) !== JSON.stringify({ args: ['--version'], constraint: '>=0.18.2 <0.19.0' })) throw new Error('Hermes discovery version contract changed');
if (JSON.stringify(candidate.launchArgs) !== JSON.stringify(['acp']) || candidate.probe?.kind !== 'acp-initialize' || candidate.probe.timeoutMs !== 15000) throw new Error('Hermes discovery must use the bounded ACP probe');
const capabilities = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.capabilities), 'utf8'));
const expectedCapabilities = { imageInput: true, audioInput: false, embeddedContext: false, interrupt: true, resume: true, permissionModes: true, modelSelection: false, commands: true, browserUse: true, skills: true };
if (JSON.stringify(capabilities.declared) !== JSON.stringify(expectedCapabilities)) throw new Error('Hermes capabilities changed without runtime evidence');
const composer = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.composer), 'utf8'));
const expectedModes = [{ runtimeId: 'dont_ask', semantic: 'full-access', automaticDecision: 'approved' }];
if (JSON.stringify(composer.permissionModes) !== JSON.stringify(expectedModes)) throw new Error('Hermes signed permission policy changed');
const expectedSlashCommands = { commandCatalogAuthoritative: true, commands: [{ name: 'compact', effect: 'submitImmediate' }, { name: 'context', effect: 'submitImmediate' }, { name: 'status', effect: 'showStatus' }] };
if (JSON.stringify(composer.slashCommands) !== JSON.stringify(expectedSlashCommands)) throw new Error('Hermes signed slash command policy changed');
const expectedSkills = { invocation: 'textTrigger', triggerPrefix: '/', roots: [{ scope: 'workspace', path: '.agent_context/skills' }, { scope: 'user', path: '.agent_context/skills' }, { scope: 'user', path: '.hermes/skills' }] };
if (JSON.stringify(composer.skills) !== JSON.stringify(expectedSkills)) throw new Error('Hermes Skill roots changed');
const expectedRuntimePrep = { instructionsFile: 'AGENTS.md', home: { envVar: 'HERMES_HOME', dirName: 'hermes', sourceEnvVar: 'HERMES_HOME', sourceDefaultRel: '.hermes', copyFiles: ['config.yaml', 'auth.json', '.env'], configFile: 'config.yaml', configFormat: 'yaml', externalDirsKey: ['skills', 'external_dirs'], userHomeSkillDir: 'skills', includeSkillRoots: true, includeUserHomeDir: true } };
if (JSON.stringify(composer.runtimePrep) !== JSON.stringify(expectedRuntimePrep)) throw new Error('Hermes runtimePrep overlay changed');
const tools = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.tools), 'utf8'));
if (tools.tools?.length !== 0) throw new Error('Hermes tools must remain generic');
await rejectExecutables(packageDir);
async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
