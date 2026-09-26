import {
  createPasswordHash
} from "./authCrypto.js";


function readHidden(
  prompt
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const stdin =
        process.stdin;

      const stdout =
        process.stdout;


      if (!stdin.isTTY) {

        reject(
          new Error(
            "This command must be run from a terminal."
          )
        );

        return;
      }


      let value = "";


      stdout.write(
        prompt
      );


      stdin.setRawMode(true);

      stdin.resume();

      stdin.setEncoding(
        "utf8"
      );


      function cleanup() {

        stdin.setRawMode(false);

        stdin.pause();

        stdin.removeListener(
          "data",
          onData
        );
      }


      function onData(
        input
      ) {

        for (
          const character
          of input
        ) {

          /*
           * Ctrl+C
           */
          if (
            character === "\u0003"
          ) {

            cleanup();

            stdout.write("\n");

            reject(
              new Error(
                "Cancelled."
              )
            );

            return;
          }


          /*
           * Enter
           */
          if (
            character === "\r" ||
            character === "\n"
          ) {

            cleanup();

            stdout.write("\n");

            resolve(value);

            return;
          }


          /*
           * Backspace
           */
          if (
            character === "\u007f" ||
            character === "\b"
          ) {

            if (
              value.length > 0
            ) {

              value =
                value.slice(
                  0,
                  -1
                );

              stdout.write(
                "\b \b"
              );
            }

            continue;
          }


          if (
            character >= " "
          ) {

            value +=
              character;

            stdout.write("*");
          }
        }
      }


      stdin.on(
        "data",
        onData
      );
    }
  );
}


async function main() {

  const password =
    await readHidden(
      "Admin password: "
    );


  if (
    password.length < 12
  ) {

    throw new Error(
      "Use an admin password of at least 12 characters."
    );
  }


  const confirmation =
    await readHidden(
      "Confirm password: "
    );


  if (
    password !== confirmation
  ) {

    throw new Error(
      "Passwords do not match."
    );
  }


  const hash =
    await createPasswordHash(
      password
    );


  console.log(
    "\nCopy this value into ADMIN_PASSWORD_HASH:\n"
  );

  console.log(hash);
}


main().catch(
  error => {

    console.error(
      error.message
    );

    process.exit(1);
  }
);