package main

import "strings"

// stubMountProbe answers the CLI's mount-source probe: one
// `<name>|<source>` line per requested container, source defaulting to root.
// It lives beside the mount suites it serves, so the shared up-capture module
// stays under the god-object function ceiling.
func (c *upCapture) stubMountProbe(root string, arg []string) runner {
	c.mountProbes++
	c.mountArgv = append(c.mountArgv, append([]string(nil), arg...))
	if c.mountErr != nil {
		err := c.mountErr
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, err }}
	}
	var b strings.Builder
	for _, name := range mountProbeNames(arg) {
		if c.mountSkipped[name] {
			continue
		}
		b.WriteString("/" + name + "|" + c.mountSource(root, name) + "\n")
	}
	return &mockCmd{outputFn: func() ([]byte, error) { return []byte(b.String()), nil }}
}

// mountProbeNames returns the container names after the inspect --format
// template.
func mountProbeNames(arg []string) []string {
	for i, a := range arg {
		if a == containerMountProbeFormat && i+1 < len(arg) {
			return arg[i+1:]
		}
	}
	return nil
}

// mountSource is the host path the probe reports for name: the test override
// when set, else the workspace root.
func (c *upCapture) mountSource(root, name string) string {
	if source, ok := c.mounts[name]; ok {
		return source
	}
	return root
}
