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
const c = require("ansi-colors");

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
    let answer = fzfChoice(
      [
        { type: "a", label: "Add Item" },
        { type: "e", label: "Edit Item" },
        { type: "l", label: "Lookup Item" },
        { type: "p", label: "Print Database" },
      ],
      {
        prompt: "Pick Action >",
      }
    ).type;

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

function fzfChoice(
  choices,
  { nameFn = d => d.label, header = "", prompt = "" } = {}
) {
  let input = [];
  let args = ["--with-nth", 2, "--delimiter", "';'", "--info", "hidden"];

  if (header) {
    let headerWidth = header
      .split("\n")
      .reduce((acc, line) => Math.max(acc, line.length), 0);

    let headerLines = header
      .split("\n")
      .map(line => `header;${line}`)
      .concat(["", `;${"–".repeat(headerWidth)}`, ""]);

    input = input.concat(headerLines);
    args.push("--header-lines", headerLines.length);
  }

  if (prompt) {
    args.push("--prompt", `'${prompt} '`);
  }

  let fzfLines = choices.map((d, i) => `${i};${nameFn(d)}`);
  input = input.concat(fzfLines);

  fs.writeFileSync(FZF_FILE, input.join("\n"));

  rl.pause();

  const info = spawnSync(
    `cat ${FZF_FILE} | fzf ${args.join(" ")} > ${FZF_OUT_FILE}`,
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

  let output = fs.readFileSync(FZF_OUT_FILE).toString().trim().split(";")[0];
  return choices[parseInt(output)];
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

async function editItem(db) {
  let item = await matchItem(db, { add: false });

  let newItem = await addItem(db, {
    name: item.name,
    ingredients: clone(item.ingredients),
    context: `Replacing item: ${item.name}`,
    save: false,
  });

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

async function addItem(
  db,
  {
    sourceName = "",
    name = "",
    ingredients = [],
    save = true,
    context = "",
  } = {}
) {
  let choices = [
    { type: "n", label: "Set Name" },
    { type: "a", label: "Add Ingredient" },
    { type: "s", label: "Commit Item" },
    { type: "c", label: "Clear Ingredients" },
    // TODO: quit without save
  ];

  let error = "";

  while (true) {
    let ingredientLabels = ingredients.map(
      ing => `${ing.quantity} ${ing.name}`
    );

    let header = [];

    if (error) header.push(c.red(error));
    if (context) header.push(context);

    header.push(`Building Item${sourceName ? ` for ${sourceName}` : ""}:`);

    let selected = fzfChoice(choices, {
      prompt: "Action >",
      header: outdent`
          ${header.join("\n")}

          Name: ${name}
          Ingredients:
            ${indent(ingredientLabels.join("\n") || "None", 4)}
      `,
    });

    if (selected.type === "n") {
      name = await ask(`Enter name:`);
    } else if (selected.type === "a") {
      let ingredientItem = await matchItem(db, {
        header: `Find ingredient for ${name}`,
        addOpts: { sourceName: name },
      });

      let quantity = await ask(
        `Enter quantity (default: 1) ${ingredientItem.name} -> ${name}:`
      );

      if (quantity) {
        quantity = parseInt(quantity);
      } else {
        quantity = 1;
      }

      ingredients.push({
        name: ingredientItem.name,
        quantity,
      });
    } else if (selected.type === "s") {
      if (!name) {
        error = "No name set!";
        console.log("No Name set");
        continue;
      }

      let item = {
        name,
        ingredients,
      };

      if (save) {
        db.addItem(item);
        db.write();
      }

      return item;
    } else if (selected.type === "c") {
      ingredients = [];
    } else {
      console.log(`No action found for: ${JSON.stringify(selected)}`);
    }
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

async function matchItem(db, { header = "", add = true, addOpts }) {
  let choices = [];
  if (add) {
    choices.push({ type: "add", label: "Add Item" });
  }

  choices.push(
    ...db.items.map(i => {
      return { type: "item", item: i, label: `${db.itemLabel(i)}` };
    })
  );

  let selected = fzfChoice(choices, {
    prompt: "Search for Item >",
    header,
  });

  if (selected.type === "add") {
    return await addItem(db, addOpts);
  }

  return selected.item;
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

  get items() {
    return this.data.items;
  }

  itemLabel(item) {
    let info = [];
    for (let ing of item.ingredients) {
      info.push(`${ing.quantity} ${ing.name}`);
    }

    return `${item.name} – Ingredients: ${info.join(",")}`;
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
