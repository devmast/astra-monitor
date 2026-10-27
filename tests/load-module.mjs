import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual TypeScript modules with only their platform dependencies mocked.
export async function loadModule(path, mocks = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const module = new vm.SourceTextModule(code);
    await module.link(specifier => {
        if(!(specifier in mocks)) throw new Error(`Unexpected import: ${specifier}`);
        const exports = mocks[specifier];
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for(const [name, value] of Object.entries(exports)) this.setExport(name, value);
        });
    });
    await module.evaluate();
    return module.namespace;
}
