# Extension release mount

Place one signed Remote Tab CRX and its matching `updates.xml` in this directory before starting a
Chrome node. The `extensionId` in `runtime.env`, the update manifest and the signing key must refer
to the same Extension identity.

Do not place the private signing key in this directory or in a container image.
