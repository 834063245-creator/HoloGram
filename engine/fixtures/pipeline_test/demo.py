import subprocess
import ctypes

def run_shell():
    proc = subprocess.Popen(['ls'], shell=True)
    return proc.wait()

def load_lib(path):
    lib = ctypes.CDLL(path)
    return lib.init()

def dynamic_mod(name):
    return __import__(name)

def run_dynamic(code):
    return eval(code)

def reflect(obj, attr):
    return getattr(obj, attr)
