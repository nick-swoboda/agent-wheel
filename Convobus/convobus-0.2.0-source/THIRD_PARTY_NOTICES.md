# Third-party notices

The downloadable macOS application includes the official Node.js 22.23.2 LTS
runtime so end users do not need to install Node.js or another language runtime.

The Apple-silicon and Intel runtime binaries are downloaded from the official
Node.js distribution at <https://nodejs.org/dist/v22.23.2/> and verified against
these SHA-256 values before they are combined into the universal app runtime:

- `5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1`
  (`node-v22.23.2-darwin-arm64.tar.xz`)
- `96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7`
  (`node-v22.23.2-darwin-x64.tar.xz`)

Node.js is distributed under the MIT License and includes components under
compatible open-source licenses. The complete license and dependency notices
shipped by Node.js are included inside the application at
`Convobus.app/Contents/Resources/Runtime/Node-LICENSE.txt`.
