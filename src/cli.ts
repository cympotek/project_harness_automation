#!/usr/bin/env node
/**
 * harness CLI entrypoint.
 *
 * For task 1.1 this only parses args and exits 0 on success.
 * Actual agent/sensor logic is added in tasks 1.3+.
 */

import { Command } from "commander";

const program = new Command();

program
  .name("harness")
  .description(
    "Self-driving coding-agent harness: run → verify → loop → done or escalate.",
  )
  .version("0.1.0");

const runCmd = program
  .command("run")
  .description("Run the harness loop against a target repository.")
  .requiredOption("--task <id>", "Unique task identifier")
  .requiredOption("--repo <path>", "Absolute path to the target repository")
  .option(
    "--verify <cmd>",
    "Verification command to run after each agent attempt (repeatable)",
    (value: string, previous: string[]) => {
      return [...previous, value];
    },
    [] as string[],
  )
  .option(
    "--max-attempts <n>",
    "Maximum number of agent attempts before escalation (default: 3)",
    "3",
  )
  .action((opts: { task: string; repo: string; verify: string[]; maxAttempts: string }) => {
    const maxAttempts = parseInt(opts.maxAttempts, 10);
    if (isNaN(maxAttempts) || maxAttempts < 1) {
      console.error("Error: --max-attempts must be a positive integer");
      process.exit(1);
    }

    // Task 1.1: parse args and exit 0. Agent/sensor logic added in 1.3+.
    console.log(`harness run`);
    console.log(`  task:         ${opts.task}`);
    console.log(`  repo:         ${opts.repo}`);
    console.log(`  verify cmds:  ${opts.verify.length === 0 ? "(none)" : opts.verify.join(", ")}`);
    console.log(`  maxAttempts:  ${maxAttempts}`);
    console.log();
    console.log("(scaffold only — agent/sensor logic not yet implemented)");
    process.exit(0);
  });

// Ensure --help on `run` subcommand also works cleanly.
void runCmd;

program.parse(process.argv);
