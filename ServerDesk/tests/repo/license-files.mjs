import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../support/paths.mjs';

// The whole repository is one product under AGPL-3.0: the root LICENSE is the
// unmodified AGPL-3.0 text, there is no second license file, the README
// "License" section names AGPL-3.0 for the whole repository, and
// CONTRIBUTING.md has inbound = outbound contribution terms with the exact
// consent sentence.
const repo = repositoryRoot;
const at = (relative) => path.join(repo, relative);
const read = (relative) => fs.readFileSync(at(relative), 'utf8').replaceAll('\r\n', '\n');
const exists = (relative) => fs.statSync(at(relative), { throwIfNoEntry: false })?.isFile() === true;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const section = (text, heading) => {
  const lines = text.split('\n'), start = lines.indexOf(heading);
  check(start !== -1, `the file has the section "${heading}"`);
  const level = heading.match(/^#+/)[0].length;
  const next = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n');
};

// 1. Root LICENSE is the unmodified AGPL-3.0 text.
check(exists('LICENSE'), 'root LICENSE exists');
const agpl = read('LICENSE');
check(agpl.split('\n').find((line) => line.trim() !== '')?.includes('GNU AFFERO GENERAL PUBLIC LICENSE'), 'first non-empty line of LICENSE names the AGPL');
check(agpl.includes('Version 3, 19 November 2007'), 'LICENSE is version 3 of 19 November 2007');
const sections = [
  'Definitions.', 'Source Code.', 'Basic Permissions.', "Protecting Users' Legal Rights From Anti-Circumvention Law.",
  'Conveying Verbatim Copies.', 'Conveying Modified Source Versions.', 'Conveying Non-Source Forms.', 'Additional Terms.',
  'Termination.', 'Acceptance Not Required for Having Copies.', 'Automatic Licensing of Downstream Recipients.', 'Patents.',
  "No Surrender of Others' Freedom.", 'Remote Network Interaction; Use with the GNU General Public License.',
  'Revised Versions of this License.', 'Disclaimer of Warranty.', 'Limitation of Liability.', 'Interpretation of Sections 15 and 16.',
];
check(sections.length === 18, 'all 18 AGPL section headings are listed');
sections.forEach((title, index) => check(agpl.includes(`${index}. ${title}`), `LICENSE contains section "${index}. ${title}"`));
check(agpl.includes('END OF TERMS AND CONDITIONS'), 'LICENSE contains END OF TERMS AND CONDITIONS');
check(agpl.includes('How to Apply These Terms to Your New Programs'), 'LICENSE contains the how-to-apply appendix');
check(agpl.length >= 30_000, `LICENSE has at least 30000 characters (${agpl.length})`);

// 2. There is no second license file of the product. Paths and names of the
// former second license are built from parts: tests/repo/single-edition.mjs
// forbids them in the tree.
check(!exists(['ServerDesk', 'msp', 'LICENSE'].join('/')), 'the former second license file does not exist');

// 3. The README "License" section: AGPL-3.0 for the whole repository, nothing else.
const license = section(read('README.md'), '## License');
for (const needle of ['AGPL-3.0', 'whole repository', '[`LICENSE`](LICENSE)', 'CONTRIBUTING.md'])
  check(license.includes(needle), `README "License" section names ${needle}`);
for (const word of [new RegExp(['com', 'mercial'].join(''), 'i'), /MSP/, /trial/i])
  check(!word.test(license), `README "License" section does not contain ${word}`);

// 4. CONTRIBUTING.md: the contribution terms and the exact consent sentence.
check(exists('CONTRIBUTING.md'), 'CONTRIBUTING.md exists');
const contributing = read('CONTRIBUTING.md');
const terms = section(contributing, '## Contribution terms');
for (const needle of ['You keep the copyright in your contribution.', 'under the license of the project, the AGPL-3.0 ([`LICENSE`](LICENSE))',
  'The project owner gets no other rights', 'no grant of rights', 'no extra patent license', 'Section 11 of the AGPL-3.0 already covers patents.',
  'You have the right to submit your contribution.', 'with its origin and its license', 'The project does not have to accept your contribution.'])
  check(terms.includes(needle), `the contribution terms say: ${needle}`);
check(contributing.split('\n').includes('### Consent'), 'CONTRIBUTING.md has the section "### Consent"');
const consent = 'I submit this contribution under the AGPL-3.0 license of this project.';
check(section(contributing, '### Consent').split('\n').includes(consent), 'the consent block holds the exact sentence');
for (const word of ['Draft', '[PROJECT OWNER', 'sublicense', ['ServerDesk', 'MSP', 'License'].join(' '), 'Contributor agreement'])
  check(!contributing.includes(word), `CONTRIBUTING.md does not contain ${word}`);
check(/contribution terms/.test(contributing.split('\n').slice(0, 5).join('\n')), 'the intro paragraph refers to the contribution terms');
check(section(read('README.md'), '## Contributing and security').includes('contribution terms'), 'the README section "Contributing and security" refers to the contribution terms');

console.log(`${checks} license file checks passed.`);
