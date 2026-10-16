/**
 * Pull the errors out of a LaTeX log, so an agent can fix what it broke.
 */

export interface LatexProblem {
  message: string;
  file?: string;
  line?: number;
  context?: string;
}

export function parseLatexErrors(log: string, limit = 10): LatexProblem[] {
  const lines = log.split('\n');
  const problems: LatexProblem[] = [];
  const fileStack: string[] = [];

  for (let i = 0; i < lines.length && problems.length < limit; i++) {
    const line = lines[i];
    // Track the file being read: "(./sections/intro.tex" opens one.
    for (const match of line.matchAll(/\((\.?\/?[^\s()]+\.(?:tex|sty|cls|bbl))/g)) fileStack.push(match[1].replace(/^\.\//, ''));

    const fileLineError = line.match(/^(\.?\/?[^:\s]+\.tex):(\d+): (.*)$/);
    if (fileLineError) {
      problems.push({ file: fileLineError[1].replace(/^\.\//, ''), line: Number(fileLineError[2]), message: fileLineError[3] });
      continue;
    }

    if (line.startsWith('! ')) {
      const problem: LatexProblem = { message: line.slice(2).trim() };
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const at = lines[j].match(/^l\.(\d+)\s?(.*)$/);
        if (at) {
          problem.line = Number(at[1]);
          problem.context = at[2]?.trim() || undefined;
          break;
        }
      }
      const texFiles = fileStack.filter(f => f.endsWith('.tex'));
      if (texFiles.length) problem.file = texFiles[texFiles.length - 1];
      problems.push(problem);
    }
  }
  return problems;
}
