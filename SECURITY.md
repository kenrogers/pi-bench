# Security

Pi-Bench creates temporary benchmark workspaces and asks a coding agent to edit
files inside them. It is intended for local, trusted use.

Please do not run Pi-Bench against models or Pi setups you do not trust on a
machine with sensitive data. The benchmark prompt tells agents to stay inside
the generated workspace, but Pi-Bench is not a sandbox.

If you find a security issue, please open a private GitHub security advisory on
the repository or contact the maintainer directly.
