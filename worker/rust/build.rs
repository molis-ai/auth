#[path = "src/contract_structure.rs"]
mod contract_structure;

use serde_json::Value;
use std::{env, fmt::Write, fs, path::PathBuf};

fn main() {
    const CONTRACT: &str = "../../contracts/unified-account/openapi.json";
    println!("cargo:rerun-if-changed=../../contracts/unified-account/openapi.json");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let source = fs::read(manifest.join(CONTRACT)).expect("read OpenAPI contract");
    let doc: Value = serde_json::from_slice(&source).expect("parse OpenAPI contract");
    let mut routes = String::from("&[\n");
    let mut log_routes = String::from("&[\n");
    for (template, operations) in doc["paths"].as_object().expect("OpenAPI paths") {
        writeln!(log_routes, "    {template:?},").expect("write log route");
        if !template.starts_with("/api/account/") {
            continue;
        }
        let Some(operations) = operations.as_object() else {
            continue;
        };
        for (method, declaration) in operations {
            let variant = match method.as_str() {
                "head" => "Head",
                "get" => "Get",
                "post" => "Post",
                "put" => "Put",
                "patch" => "Patch",
                "delete" => "Delete",
                "options" => "Options",
                "connect" => "Connect",
                "trace" => "Trace",
                "report" => "Report",
                _ => continue,
            };
            if declaration["operationId"]
                .as_str()
                .is_some_and(|operation| operation.starts_with("product_"))
            {
                writeln!(routes, "    (Method::{variant}, {template:?}),").expect("write route");
            }
        }
    }
    routes.push_str("]\n");
    log_routes.push_str("]\n");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    fs::write(output.join("product_routes.rs"), routes).expect("write product route table");
    fs::write(output.join("log_routes.rs"), log_routes).expect("write log route table");
    generate_contract_patterns(&manifest, output);
}

fn generate_contract_patterns(manifest: &std::path::Path, output: PathBuf) {
    const SCHEMAS: &str = "../../contracts/unified-account/schemas.json";
    const PROFILE: &str = "../../contracts/unified-account/validator-profile.json";
    for path in [SCHEMAS, PROFILE, "src/contract_structure.rs"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let read_json = |path| {
        serde_json::from_slice::<Value>(&fs::read(manifest.join(path)).expect("read schema JSON"))
            .expect("parse schema JSON")
    };
    let document = read_json(SCHEMAS);
    let profile = read_json(PROFILE);
    let patterns = contract_structure::compile_document(&document, &profile)
        .unwrap_or_else(|error| panic!("invalid unified account schema: {error}"));
    let patterns: Vec<_> = patterns.into_iter().collect();
    fs::write(
        output.join("contract_patterns.rs"),
        format!("&{patterns:#?}"),
    )
    .expect("write contract patterns");
}
