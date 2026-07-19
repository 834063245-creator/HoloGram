/* gcc-wrap.c — static-libstdc++ linker wrapper for MinGW.
 *
 * PROBLEM: rustc's x86_64-pc-windows-gnu target hardcodes
 *   `-Wl,-Bdynamic -lstdc++` in its late_link_args.  The -static-libstdc++
 *   driver flag can't override this explicit -Wl,-Bdynamic.
 *
 * FIX: this wrapper patches rustc's linker response file (@file):
 *   -lstdc++  →  -Wl,-Bstatic  -lstdc++  -Wl,-Bdynamic
 *
 * Since -lstdc++ sits AFTER all object files (in the system libs section),
 * the linker has already seen C++ symbol references and will resolve them
 * from libstdc++.a instead of libstdc++.dll.a.
 *
 * Build:  gcc -O2 -o gcc-wrap.exe gcc-wrap.c
 * Config: .cargo/config.toml → linker = "path/to/gcc-wrap.exe"
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>

#define REAL_GCC "D:\\mingw64\\bin\\gcc.exe"

int main(int argc, char *argv[]) {
    /* Find @file argument */
    const char *at_path = NULL;
    int at_idx = -1;
    for (int i = 1; i < argc; i++) {
        if (argv[i] && argv[i][0] == '@') {
            at_path = argv[i] + 1;
            at_idx = i;
            break;
        }
    }

    /* No response file → pass through directly with static flags prepended */
    if (!at_path) {
        int extra = 3, total = 1 + extra + (argc - 1);
        char **na = (char **)malloc((total + 1) * sizeof(char *));
        if (!na) return 1;
        int p = 0;
        na[p++] = "gcc";
        na[p++] = "-Wl,-Bstatic";
        na[p++] = "-lstdc++";
        na[p++] = "-Wl,-Bdynamic";
        for (int i = 1; i < argc; i++) na[p++] = argv[i];
        na[p] = NULL;
        _execv(REAL_GCC, (const char *const *)na);
        intptr_t rc = _spawnv(_P_WAIT, REAL_GCC, (const char *const *)na);
        free(na);
        return (int)rc;
    }

    /* Read & patch the response file:
     *   -lstdc++  →  -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic
     * Write patched copy to a temp file next to the original
     */
    FILE *in = fopen(at_path, "rb");
    if (!in) return 1;

    /* Build temp path: <original_dir>/<original_name>-static.rsp */
    char *tmp_path = (char *)malloc(strlen(at_path) + 32);
    if (!tmp_path) { fclose(in); return 1; }
    strcpy(tmp_path, at_path);
    /* Replace last 4 chars (.rsp or whatever extension) or just append */
    char *dot = strrchr(tmp_path, '.');
    if (dot) *dot = '\0';
    strcat(tmp_path, "-static.rsp");

    FILE *out = fopen(tmp_path, "wb");
    if (!out) { free(tmp_path); fclose(in); return 1; }

    char line[8192];
    int patched = 0;
    while (fgets(line, sizeof(line), in)) {
        size_t len = strlen(line);
        /* Strip trailing newline */
        if (len > 0 && line[len-1] == '\n') line[--len] = '\0';
        if (len > 0 && line[len-1] == '\r') line[--len] = '\0';

        if (strcmp(line, "-lstdc++") == 0) {
            fputs("-Wl,-Bstatic\n-lstdc++\n-Wl,-Bdynamic\n", out);
            patched = 1;
        } else {
            fprintf(out, "%s\n", line);
        }
    }
    fclose(in);
    fclose(out);

    if (!patched) {
        /* No -lstdc++ found — just use the original file */
        remove(tmp_path);
        free(tmp_path);

        int extra = 3, total = 1 + extra + (argc - 1);
        char **na = (char **)malloc((total + 1) * sizeof(char *));
        if (!na) return 1;
        int p = 0;
        na[p++] = "gcc";
        na[p++] = "-Wl,-Bstatic";
        na[p++] = "-lstdc++";
        na[p++] = "-Wl,-Bdynamic";
        for (int i = 1; i < argc; i++) na[p++] = argv[i];
        na[p] = NULL;
        _execv(REAL_GCC, (const char *const *)na);
        intptr_t rc = _spawnv(_P_WAIT, REAL_GCC, (const char *const *)na);
        free(na);
        return (int)rc;
    }

    /* Build new argv referencing the patched response file */
    int extra = 3, total = 1 + extra + (argc - 1);
    char **new_argv = (char **)malloc((total + 1) * sizeof(char *));
    if (!new_argv) { free(tmp_path); return 1; }

    int pos = 0;
    new_argv[pos++] = "gcc";
    new_argv[pos++] = "-Wl,-Bstatic";
    new_argv[pos++] = "-lstdc++";
    new_argv[pos++] = "-Wl,-Bdynamic";
    for (int i = 1; i < argc; i++) {
        if (i == at_idx) {
            /* Replace @original with @patched */
            char *at_arg = (char *)malloc(strlen(tmp_path) + 2);
            at_arg[0] = '@';
            strcpy(at_arg + 1, tmp_path);
            new_argv[pos++] = at_arg;
        } else {
            new_argv[pos++] = argv[i];
        }
    }
    new_argv[pos] = NULL;

    _execv(REAL_GCC, (const char *const *)new_argv);

    /* _execv failed — fallback to spawn */
    intptr_t rc = _spawnv(_P_WAIT, REAL_GCC, (const char *const *)new_argv);

    /* Clean up temp file */
    remove(tmp_path);
    free(tmp_path);
    free(new_argv);
    return (int)rc;
}
