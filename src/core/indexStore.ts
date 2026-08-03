import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceIndex } from './types';

const FILE_NAME = 'source-index-v1.json';

export class SourceIndexStore {
  constructor(private readonly storagePath: string) {}

  private get filePath(): string {
    return path.join(this.storagePath, FILE_NAME);
  }

  async load(): Promise<SourceIndex | undefined> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const index = JSON.parse(content) as SourceIndex;
      return index.version === 1 && Array.isArray(index.sites) ? index : undefined;
    } catch {
      return undefined;
    }
  }

  async save(index: SourceIndex): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(index), 'utf8');
  }
}
