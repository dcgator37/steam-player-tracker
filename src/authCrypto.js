import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} from "node:crypto";

import {
  promisify
} from "node:util";


const scryptAsync =
  promisify(scrypt);


const KEY_LENGTH = 64;


export async function createPasswordHash(
  password
) {

  const salt =
    randomBytes(16);


  const derivedKey =
    await scryptAsync(
      password,
      salt,
      KEY_LENGTH
    );


  return [
    "scrypt",
    salt.toString("hex"),
    derivedKey.toString("hex")
  ].join("$");
}


export async function verifyPasswordHash(
  password,
  storedHash
) {

  if (
    typeof storedHash !== "string"
  ) {

    return false;
  }


  const parts =
    storedHash.split("$");


  if (
    parts.length !== 3 ||
    parts[0] !== "scrypt"
  ) {

    return false;
  }


  const [
    ,
    saltHex,
    hashHex
  ] =
    parts;


  try {

    const salt =
      Buffer.from(
        saltHex,
        "hex"
      );


    const expected =
      Buffer.from(
        hashHex,
        "hex"
      );


    const actual =
      await scryptAsync(
        password,
        salt,
        expected.length
      );


    if (
      actual.length !==
      expected.length
    ) {

      return false;
    }


    return timingSafeEqual(
      actual,
      expected
    );


  } catch {

    return false;
  }
}


export function createSessionToken() {

  return randomBytes(32)
    .toString("base64url");
}


export function hashSessionToken(
  token
) {

  return createHash("sha256")
    .update(token)
    .digest("hex");
}