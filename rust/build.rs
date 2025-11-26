use std::env;
use std::fs;
use std::path::Path;

use strum::VariantArray;
use wreq_util::{Emulation, EmulationOS};

fn main() {
    // Get all variants directly from the enum using VARIANTS API
    let profiles: Vec<String> = Emulation::VARIANTS
        .iter()
        .map(|variant| {
            serde_json::to_value(variant)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();

    let operating_systems: Vec<String> = EmulationOS::VARIANTS
        .iter()
        .map(|variant| {
            serde_json::to_value(variant)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();

    println!("cargo:warning=Found {} browser profiles", profiles.len());
    println!(
        "cargo:warning=Found {} operating systems",
        operating_systems.len()
    );

    // Generate TypeScript type definition
    let ts_type = generate_typescript_types(&profiles, &operating_systems);

    // Generate Rust profiles array
    let rust_profiles = generate_rust_profiles(&profiles, &operating_systems);

    // Write to src directory (going up one level from rust/)
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();

    // Write TypeScript types
    let ts_dest = Path::new(&manifest_dir)
        .parent()
        .unwrap()
        .join("src")
        .join("generated-types.ts");
    fs::write(&ts_dest, ts_type).unwrap();

    // Write Rust profiles array
    let rust_dest = Path::new(&manifest_dir)
        .join("src")
        .join("generated_profiles.rs");
    fs::write(&rust_dest, rust_profiles).unwrap();

    println!("cargo:rerun-if-changed=build.rs");
}

fn generate_typescript_types(profiles: &[String], operating_systems: &[String]) -> String {
    let mut ts_content = String::from(
        "/**\n * Auto-generated from Rust build script\n * DO NOT EDIT MANUALLY\n */\n\n",
    );

    ts_content.push_str("/**\n * Browser profile names supported\n */\n");
    ts_content.push_str("export type BrowserProfile =\n");

    for (i, profile) in profiles.iter().enumerate() {
        if i == profiles.len() - 1 {
            // Last profile - put semicolon on same line
            ts_content.push_str(&format!("  | '{}';\n", profile));
        } else {
            ts_content.push_str(&format!("  | '{}'\n", profile));
        }
    }

    ts_content.push_str("\n/**\n * Operating systems supported for emulation\n */\n");
    ts_content.push_str("export type EmulationOS =\n");

    for (i, os) in operating_systems.iter().enumerate() {
        if i == operating_systems.len() - 1 {
            ts_content.push_str(&format!("  | '{}';\n", os));
        } else {
            ts_content.push_str(&format!("  | '{}'\n", os));
        }
    }

    ts_content
}

fn generate_rust_profiles(profiles: &[String], operating_systems: &[String]) -> String {
    let mut rust_content =
        String::from("// Auto-generated from build script\n// DO NOT EDIT MANUALLY\n\n");

    rust_content.push_str("pub const BROWSER_PROFILES: &[&str] = &[\n");

    for profile in profiles {
        rust_content.push_str(&format!("    \"{}\",\n", profile));
    }

    rust_content.push_str("];\n");

    rust_content.push_str("\npub const OPERATING_SYSTEMS: &[&str] = &[\n");

    for os in operating_systems {
        rust_content.push_str(&format!("    \"{}\",\n", os));
    }

    rust_content.push_str("];\n");

    rust_content
}
