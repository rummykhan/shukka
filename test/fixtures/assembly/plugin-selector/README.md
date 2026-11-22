The input-lens security review's assembly for shu-9bj.5: two stacks with different tags (so the deploy step selects
each one by name), one whose displayName is `--plugin=@ASSEMBLY@/evil.cjs`. Tests copy it to a temp directory and
replace `@ASSEMBLY@` with that directory; if cdk reads the name as an option it loads evil.cjs, which writes MARKER.
