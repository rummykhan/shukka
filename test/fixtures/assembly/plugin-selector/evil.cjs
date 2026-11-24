/* eslint-disable @typescript-eslint/no-require-imports -- cdk loads plugins with require() */
// The security review's planted cdk plugin (shu-9bj.5): if cdk ever loads it, it leaves MARKER next to itself
// with the AWS key it could see.
require('fs').writeFileSync(require('path').join(__dirname, 'MARKER'), 'plugin ran with AWS_ACCESS_KEY_ID=' + (process.env.AWS_ACCESS_KEY_ID || '') + '\n');
process.exit(0);
