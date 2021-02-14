#!/usr/bin/env node

const DATA_FILE = "data/data.json";
const FZF_FILE = "/var/tmp/planner.fzf";
const FZF_OUT_FILE = "/var/tmp/planner.fzf.out";

const fs = require("fs");
const md5sum = require("md5");
const readline = require("readline-promise").default;
const outdent = require("outdent");
const util = require("util");
const spawnSync = require("child_process").spawnSync;
const indent = require("indent-string");

const rl = readline.createInterface({
  terminal: true,
  input: process.stdin,
  output: process.stdout,
});

function q(str) {
  return `\n${str} `;
}

async function main() {
  let db = new Db();
  console.log(db.data, "\n");

  while (true) {
    let answer = await ask(outdent`
      Actions:
        a - add item
        e - edit item

      Info:
        p - print data
        l - lookup item

      q - quit

      What do you want to do:
    `);
    if (answer === "q") break;
    if (answer in DISPATCH) {
      await DISPATCH[answer](db);
    } else {
      console.log(`No action: ${answer}`);
    }
  }

  db.write();
  rl.close();
}

const DISPATCH = {
  a: addItem,
  e: editItem,
  p: printData,
  l: lookupItem,
};

async function editItem(db) {
  let item = await matchItem(db);

  if (!item) {
    console.log(`No item found`);
    return;
  }

  let newItem = await addItemNoSave(db);

  let correct = await askBoolean(
    outdent`
      Replace ${item.name} with:

      ${indent(json(newItem), 2)}

      Correct? (Y/n)`,
    true
  );

  if (!correct) {
    console.log("Bailing!");
    return;
  }

  db.replaceItem(item, newItem);
  db.write();
}

async function lookupItem(db) {
  let item = await matchItem(db);

  if (item) {
    console.log(outdent`
    Found: ${item.name}
    Data:

    ${indent(json(item), 2)}
    `);
  } else {
    console.log(`No Item Found!`);
  }
}

async function ask(str) {
  return (await rl.questionAsync(q(str))).trim();
}

async function askBoolean(str, defaultAnswer = false) {
  let answer = await ask(str);
  if (answer.toLowerCase() === "y") return true;
  if (answer.toLowerCase() === "n") return false;
  if (answer === "") return defaultAnswer;

  console.log(`Did not recognize: ${answer}, trying again`);
  return await askBoolean(str, defaultAnswer);
}

async function addItemNoSave(db, name) {
  if (name) {
    let answer = await ask(`Enter name: (enter to keep: ${name})`);
    if (answer) {
      name = answer;
    }
  } else {
    name = await ask(`Enter name:`);
    if (!name) {
      console.log("Bailing out of add item");
      return;
    }
  }

  let ingredients = await createIngredients(db, name);

  let item = { name, ingredients };
  return item;
}

async function addItem(db, name) {
  let item = await addItemNoSave(db, name);

  console.log(item);

  let correct = await askBoolean(
    outdent`
      Creating:
      ${indent(json(item), 2)}

      Does this look correct? (Y/n)
  `,
    true
  );

  if (correct) {
    db.addItem(item);
    db.write();
    return item;
  } else {
    console.log("Bailing!");
  }
}

async function createIngredients(db, sourceName) {
  let shouldContinue = await askBoolean("Has Ingredients? (y/N)");
  if (!shouldContinue) return [];

  let ingredients = [];
  while (true) {
    let quantity = await ask(
      `Enter quantity of ingredient for ${sourceName} (enter to quit):`
    );
    if (quantity === "") return ingredients;
    quantity = parseInt(quantity);

    let item = await matchItem(db);
    if (!item) return ingredients;

    let save = await askBoolean(
      `Got ${quantity}| of ${item.name} for ${sourceName}, Correct? (Y/n):`,
      true
    );

    if (save) {
      ingredients.push({ name: item.name, quantity });
    }
  }
}

// async function createIngredients(db, sourceName) {
//   let shouldContinue = await askBoolean("Has Ingredients? (y/N)");
//   if (!shouldContinue) return [];
//
//   let ingredients = [];
//   while (true) {
//     let input = await ask(outdent`
//       Specify Ingredient: QTY NAME
//       (q to quit):
//     `);
//
//     if (input === "q") return ingredients;
//
//     let splits = input.split(" ");
//
//     let quantity = splits[0];
//     quantity = parseInt(quantity);
//
//     let nameGuess = splits.slice(1).join(" ");
//     let item = db.matchItem(nameGuess);
//     if (item) {
//       let useItem = await askBoolean(
//         `Use found item: ${item.name} (Y/n):`,
//         true
//       );
//       if (!useItem) item = null;
//     }
//
//     if (!item) {
//       let shouldAdd = await askBoolean(`No item found, add item? (Y/n)`, true);
//       if (shouldAdd) {
//         item = await addItem(db, nameGuess);
//         if (!item) continue;
//       } else {
//         continue;
//       }
//     }
//
//     let name = item.name;
//
//     let save = await askBoolean(
//       `Got ${name} in ${quantity} amount for ${sourceName}, Correct? (Y/n):`,
//       true
//     );
//     if (save) {
//       ingredients.push({ name, quantity });
//     }
//   }
// }

async function matchItem(db) {
  db.writeFzfInput(["Add Item"]);

  rl.pause();

  const info = spawnSync(
    `/bin/cat ${FZF_FILE} | /usr/local/bin/fzf > ${FZF_OUT_FILE}`,
    [],
    {
      shell: true,
      stdio: "inherit",
    }
  );

  rl.resume();

  if (info.error) {
    return;
  }

  let output = fs.readFileSync(FZF_OUT_FILE).toString().trim().split(":")[0];
  if (output === "Add Item") {
    return await addItem(db);
  }

  return db.getItem(output);
}

function json(data) {
  return JSON.stringify(data, null, 2);
}

async function printData(db) {
  console.log(db.stringData());
}

class Db {
  constructor() {
    this.data = JSON.parse(this.getDataContents());
  }

  stringData() {
    return json(this.data);
  }

  write() {
    let str = this.stringData();
    let md5 = md5sum(str);

    fs.writeFileSync(`data/data-old-${md5}.json`, str);
    fs.writeFileSync(DATA_FILE, str);
  }

  getDataContents() {
    return fs.readFileSync(DATA_FILE);
  }

  addItem(item) {
    this.data.items.push(item);
  }

  writeFzfInput(extras = []) {
    let strings = [];
    for (let item of this.data.items) {
      let info = [];
      for (let ing of item.ingredients) {
        info.push(`${ing.quantity} ${ing.name}`);
      }

      strings.push(`${item.name}: ${info.join(",")}`);
    }

    fs.writeFileSync(FZF_FILE, strings.concat(extras).join("\n"));
  }

  replaceItem(oldItem, newItem) {
    let newList = this.data.items.filter(i => i.name !== oldItem.name);

    for (let item of newList) {
      for (let ingredient of item.ingredients) {
        if (ingredient.name === oldItem.name) {
          ingredient.name = newItem.name;
        }
      }
    }

    newList.push(newItem);

    this.data.items = newList;
  }

  getItem(name) {
    for (let item of this.data.items) {
      if (item.name === name) {
        return item;
      }
    }
  }
}

main();
