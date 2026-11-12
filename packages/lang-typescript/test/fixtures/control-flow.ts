import { readFile } from 'node:fs/promises';

export async function loadUsers(paths: string[], verbose = false) {
  const users = [];
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.active && verbose) {
        console.log(`Loaded ${parsed.name} from ${path}`);
      } else {
        continue;
      }

      users.push({ name: parsed.name, age: parsed.age ?? 0 });
    } catch (error) {
      console.error(error);
    }
  }

  switch (users.length) {
    case 0:
      throw new Error('No users');
    default:
      console.info(users.length > 1 ? 'many' : 'one');
      break;
  }

  return users.map((u) => u.name);
}

class Counter {
  private count = 0;

  increment(by: number): number {
    this.count += by;
    return this.count;
  }
}

let i = 0;
while (i < 3) {
  i++;
}
