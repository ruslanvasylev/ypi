# ypi Pure Extension Proof

This folder is a working proof that ypi's core recursive behavior can be
implemented as a Pi extension instead of a launcher wrapper.

Run the live proof:

```bash
bash pure-extension/test.sh
```

Run the current wrapper and the pure extension side by side:

```bash
bash pure-extension/compare.sh
```

The live proof copies only the extension files into a scratch root, starts `pi`
directly with `-e`, asks the root agent to use the native `rlm_query` tool, asks
that child to call the native tool again, and asserts a `depth=0->1->2` trace.
The scratch root intentionally contains no `ypi` launcher, no shell `rlm_query`,
no `SYSTEM_PROMPT.md`, and runs with `RLM_JJ=0`.

Manual one-level smoke invocation:

```bash
pi -p --no-session \
	  --provider openrouter \
	  --model openai/gpt-5.5:xhigh \
	  -e ./extensions/recursive.ts \
	  "Use the native rlm_query tool exactly once to ask a child agent: Reply with exactly OK."
```

The important distinction is that this command starts `pi` directly. There is no
`./ypi` wrapper process. The minimal proof also does not depend on the shell
helper or jj.
