import { resolveProjectOrExit, type Command } from "./shared.js";
import { gitPassthrough } from "../../../lib/git.js";

export function registerGitCommand(cmd: Command) {
  cmd
    .command("git <id-or-slug> [git-args...]")
    .description("Run a git command inside the project directory")
    .allowUnknownOption()
    .action((idOrSlug, gitArgs) => {
      const project = resolveProjectOrExit(idOrSlug);
      try {
        gitPassthrough(project.path, gitArgs as string[]);
      } catch (err: unknown) {
        process.exit(err instanceof Error && "status" in err ? (err as NodeJS.ErrnoException & { status: number }).status ?? 1 : 1);
      }
    });
}
