# Third-Party Notices

HoloGram incorporates the following third-party open source software.
This file fulfills the attribution requirements of the MIT License and other
applicable open source licenses.

---

## 1. Bundled Dynamic Libraries (grammars/)

These `.dll` files are distributed as part of the HoloGram repository and binary release.

### 1.1 aura.dll — AuraSDK

- **Source**: https://github.com/teolex2020/AuraSDK
- **License**: MIT
- **Usage**: Semantic memory recall (SDR + MinHash) for the agent memory system

```
MIT License

Copyright (c) 2026 AuraSDK

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.2 tree-sitter-kotlin.dll

- **Source**: https://github.com/tree-sitter/tree-sitter-kotlin
- **License**: MIT
- **Usage**: Kotlin syntax parsing (dynamic grammar loaded at runtime)

```
MIT License

Copyright (c) Tree-sitter Kotlin Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.3 tree-sitter-markdown.dll

- **Source**: https://github.com/tree-sitter/tree-sitter-markdown
- **License**: MIT
- **Usage**: Markdown syntax parsing (dynamic grammar loaded at runtime)

```
MIT License

Copyright (c) Tree-sitter Markdown Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.4 tree-sitter-toml.dll

- **Source**: https://github.com/tree-sitter/tree-sitter-toml
- **License**: MIT
- **Usage**: TOML syntax parsing (dynamic grammar loaded at runtime)

```
MIT License

Copyright (c) Tree-sitter TOML Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Static-Linked Rust Crates (compiled into hologram-engine.exe)

All crates sourced from [crates.io](https://crates.io). Each is listed with its license.

### 2.1 Tree-sitter Grammar Crates (26 languages · MIT)

These crates provide syntax parsing for their respective languages.
Each is copyright by its contributors and licensed under MIT.

| Crate | Version | Source Repository |
|-------|---------|-------------------|
| tree-sitter (core) | 0.25 | https://github.com/tree-sitter/tree-sitter |
| tree-sitter-language | 0.1 | https://github.com/tree-sitter/tree-sitter |
| tree-sitter-bash | 0.25 | https://github.com/tree-sitter/tree-sitter-bash |
| tree-sitter-c | 0.23 | https://github.com/tree-sitter/tree-sitter-c |
| tree-sitter-c-sharp | 0.23 | https://github.com/tree-sitter/tree-sitter-c-sharp |
| tree-sitter-cpp | 0.23 | https://github.com/tree-sitter/tree-sitter-cpp |
| tree-sitter-css | 0.25 | https://github.com/tree-sitter/tree-sitter-css |
| tree-sitter-dart | 0.2 | https://github.com/tree-sitter/tree-sitter-dart |
| tree-sitter-elixir | 0.3 | https://github.com/tree-sitter/tree-sitter-elixir |
| tree-sitter-erlang | 0.19 | https://github.com/tree-sitter/tree-sitter-erlang |
| tree-sitter-go | 0.23 | https://github.com/tree-sitter/tree-sitter-go |
| tree-sitter-haskell | 0.23 | https://github.com/tree-sitter/tree-sitter-haskell |
| tree-sitter-html | 0.23 | https://github.com/tree-sitter/tree-sitter-html |
| tree-sitter-java | 0.23 | https://github.com/tree-sitter/tree-sitter-java |
| tree-sitter-javascript | 0.23 | https://github.com/tree-sitter/tree-sitter-javascript |
| tree-sitter-json | 0.24 | https://github.com/tree-sitter/tree-sitter-json |
| tree-sitter-lua | 0.2 | https://github.com/tree-sitter/tree-sitter-lua |
| tree-sitter-nix | 0.3 | https://github.com/tree-sitter/tree-sitter-nix |
| tree-sitter-ocaml | 0.25 | https://github.com/tree-sitter/tree-sitter-ocaml |
| tree-sitter-php | 0.24 | https://github.com/tree-sitter/tree-sitter-php |
| tree-sitter-python | 0.23 | https://github.com/tree-sitter/tree-sitter-python |
| tree-sitter-r | 1.2 | https://github.com/tree-sitter/tree-sitter-r |
| tree-sitter-ruby | 0.23 | https://github.com/tree-sitter/tree-sitter-ruby |
| tree-sitter-rust | 0.23 | https://github.com/tree-sitter/tree-sitter-rust |
| tree-sitter-scala | 0.26 | https://github.com/tree-sitter/tree-sitter-scala |
| tree-sitter-swift | 0.7 | https://github.com/tree-sitter/tree-sitter-swift |
| tree-sitter-typescript | 0.23 | https://github.com/tree-sitter/tree-sitter-typescript |
| tree-sitter-yaml | 0.7 | https://github.com/tree-sitter/tree-sitter-yaml |
| tree-sitter-zig | 1.1 | https://github.com/tree-sitter/tree-sitter-zig |

> All tree-sitter crates listed above are licensed under the **MIT License**.
> Copyright held by their respective contributors. The full MIT license text
> applies to each — see Section 4 below.

### 2.2 rusqlite (bundled SQLite)

- **Crate**: rusqlite v0.31 (features: bundled)
- **License**: MIT
- **Note**: The `bundled` feature compiles and statically links SQLite3.
  SQLite itself is in the **public domain** (https://sqlite.org/copyright.html).

```
MIT License — Copyright (c) The rusqlite Developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 2.3 mimalloc

- **Crate**: mimalloc v0.1
- **Source**: https://github.com/microsoft/mimalloc
- **License**: MIT

```
MIT License — Copyright (c) 2018-2025 Microsoft Corporation, Daan Leijen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 2.4 USearch

- **Crate**: usearch v2.25
- **Source**: https://github.com/unum-cloud/usearch
- **License**: Apache-2.0

```
Apache License, Version 2.0 — Copyright (c) Unum Cloud

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### 2.5 libloading

- **Crate**: libloading v0.8
- **Source**: https://github.com/nagisa/rust_libloading
- **License**: ISC

```
ISC License — Copyright (c) 2015, Simonas Kazlauskas

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 2.6 Other Rust Crates

The following crates are also statically linked. All are sourced from crates.io
and used under their respective licenses (MIT, Apache-2.0, or dual MIT/Apache-2.0).

| Crate | Version | License |
|-------|---------|---------|
| serde | 1 | MIT / Apache-2.0 |
| serde_json | 1 | MIT / Apache-2.0 |
| tokio | 1 | MIT |
| rayon | 1.10 | MIT / Apache-2.0 |
| chrono | 0.4 | MIT / Apache-2.0 |
| parking_lot | 0.12 | MIT / Apache-2.0 |
| regex | 1 | MIT / Apache-2.0 |
| walkdir | 2 | MIT |
| rand | 0.8 | MIT / Apache-2.0 |
| notify | 6 | CC0-1.0 |
| tracing | 0.1 | MIT |
| tracing-subscriber | 0.3 | MIT |
| tracing-appender | 0.2 | MIT |
| streaming-iterator | 0.1 | MIT |

---

## 3. Tauri Shell Dependencies (src-tauri/)

These crates power the desktop application shell. All sourced from crates.io.

| Crate | Version | License |
|-------|---------|---------|
| tauri | 2 | MIT / Apache-2.0 |
| tauri-build | 2 | MIT / Apache-2.0 |
| tauri-plugin-dialog | 2 | MIT / Apache-2.0 |
| ureq | 2 | MIT / Apache-2.0 |
| glob | 0.3 | MIT / Apache-2.0 |
| url | 2 | MIT / Apache-2.0 |
| portable-pty | 0.8 | MIT |
| base64 | 0.22 | MIT / Apache-2.0 |

---

## 4. MIT License (Full Text)

The MIT License is referenced throughout this file. The complete text is:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

*This file was generated on 2026-07-08. To update: review Cargo.lock and grammars/
for new or changed dependencies.*
