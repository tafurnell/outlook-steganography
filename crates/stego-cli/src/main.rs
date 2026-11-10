//! `stego` – command-line front end to stego-core.
//!
//! The passphrase can be passed with `--passphrase` or the `STEGO_PASSPHRASE`
//! environment variable; a pre-derived key with `--key` (base64, as stored by the add-in).

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use clap::{Args, Parser, Subcommand};
use stego_core::{MasterKey, RenderOptions};

#[derive(Parser)]
#[command(name = "stego", version, about = "Hide/reveal short encrypted codes in signature images")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Args)]
struct KeyArgs {
    /// Shared passphrase (Argon2id-derived).
    #[arg(long, env = "STEGO_PASSPHRASE", hide_env_values = true)]
    passphrase: Option<String>,
    /// Pre-derived master key, base64 (alternative to --passphrase).
    #[arg(long, env = "STEGO_KEY", hide_env_values = true)]
    key: Option<String>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Derive the master key from a passphrase and print it (base64).
    DeriveKey(KeyArgs),
    /// Render a signature with a hidden message.
    Create {
        #[command(flatten)]
        key: KeyArgs,
        /// Display name to render, e.g. "Tim Furnell".
        #[arg(long)]
        name: String,
        /// Secret message (max 128 UTF-8 bytes).
        #[arg(long)]
        message: String,
        /// Output PNG (default: sig_<name>.png).
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Render a plain signature (no payload), for comparison.
    Render {
        #[arg(long)]
        name: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// Try to extract a hidden message from one or more PNGs.
    Extract {
        #[command(flatten)]
        key: KeyArgs,
        files: Vec<PathBuf>,
    },
}

fn master_key(k: &KeyArgs) -> Result<MasterKey> {
    match (&k.key, &k.passphrase) {
        (Some(b64), _) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).context("--key is not valid base64")?;
            Ok(MasterKey::from_bytes(&bytes)?)
        }
        (None, Some(p)) => Ok(stego_core::derive_master_key(p)?),
        (None, None) => Err(anyhow!("supply --passphrase, --key, STEGO_PASSPHRASE or STEGO_KEY")),
    }
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::DeriveKey(k) => {
            let key = master_key(&k)?;
            println!("{}", base64::engine::general_purpose::STANDARD.encode(key.as_bytes()));
        }
        Cmd::Create { key, name, message, out } => {
            let key = master_key(&key)?;
            let mut nonce = [0u8; 12];
            getrandom::getrandom(&mut nonce).map_err(|e| anyhow!("RNG failure: {e}"))?;
            let png = stego_core::create_signature(&key, &name, &message, nonce, &RenderOptions::default())?;
            let out = out.unwrap_or_else(|| PathBuf::from(stego_core::signature_filename(&name)));
            std::fs::write(&out, &png).with_context(|| format!("writing {}", out.display()))?;
            let (w, h) = stego_core::pngio::dimensions(&png)?;
            eprintln!("wrote {} ({w}x{h}, {} bytes)", out.display(), png.len());
        }
        Cmd::Render { name, out } => {
            let img = stego_core::render::render_signature(&name, &RenderOptions::default())?;
            std::fs::write(&out, stego_core::pngio::encode_rgb(&img)?)?;
            eprintln!("wrote {} ({}x{})", out.display(), img.width, img.height);
        }
        Cmd::Extract { key, files } => {
            let key = master_key(&key)?;
            let mut found = false;
            for f in files {
                let bytes = std::fs::read(&f).with_context(|| format!("reading {}", f.display()))?;
                match stego_core::extract_message(&key, &bytes)? {
                    Some(msg) => {
                        found = true;
                        println!("{}: {msg}", f.display());
                    }
                    None => eprintln!("{}: no embedded message", f.display()),
                }
            }
            if !found {
                std::process::exit(1);
            }
        }
    }
    Ok(())
}
