mod other;
mod util;

use crate::other::fmt as other_fmt;
use crate::util::format::fmt as util_fmt;
use std::collections::HashMap;

fn main() {
    let a = util_fmt("LoW");
    let b = other_fmt("LoW");
    let mut m: HashMap<String, String> = HashMap::new();
    m.insert(a, b);
    println!("{}", m.len());
}
