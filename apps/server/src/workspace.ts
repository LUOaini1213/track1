import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROTECTED_FIXTURE_CONTENTS,
  PROTECTED_FIXTURE_RELATIVE,
} from "./policy.js";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
    await this.writeProtectedFixture(agent.workspacePath);
  }

  async writeProtectedFixture(workspacePath: string): Promise<void> {
    await mkdir(path.join(workspacePath, ".secrets"), { recursive: true });
    await writeFile(
      path.join(workspacePath, PROTECTED_FIXTURE_RELATIVE),
      PROTECTED_FIXTURE_CONTENTS,
      "utf8",
    );
  }

  async hashProtectedFixture(workspacePath: string): Promise<string> {
    const contents = await readFile(
      path.join(workspacePath, PROTECTED_FIXTURE_RELATIVE),
      "utf8",
    );
    return createHash("sha256").update(contents).digest("hex");
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await mkdir(agent.workspacePath, { recursive: true });
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  /**
   * Move an Agent's workspace aside, or report that there was nothing to move.
   *
   * Workspace paths are stored absolute, so a moved checkout, a removed
   * worktree or a hand-deleted directory leaves an Agent pointing at nothing.
   * Throwing here made that Agent permanently undeletable: every DELETE
   * answered 500 and the record stayed in the list forever. An orphaned
   * directory is recoverable; an Agent that cannot be removed is not.
   */
  async archive(agent: Agent): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    try {
      await rename(agent.workspacePath, destination);
      return destination;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") {
        return null;
      }
      // EPERM/EBUSY on Windows means something still holds the directory open.
      // Report it to the caller rather than blocking the delete.
      if (["EPERM", "EBUSY", "EACCES"].includes(code)) {
        return null;
      }
      throw error;
    }
  }
}
