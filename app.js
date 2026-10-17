/* ============================================================
   StudyDive — client application
   Architecture note:
   - All persistence goes through the Store module (localStorage today,
     swappable for REST/API calls later without touching the UI).
   - Content generation goes through the Generator module. It currently
     builds structured study material from subject packs + the extracted
     PDF text; the same interface can later call an LLM API.
   ============================================================ */

"use strict";

/* ---------------- Utils ---------------- */
const $  = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const uid = () => "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtDate = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "long", day: "numeric" });
const fmtBytes = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const hashPw = (str) => { // djb2 — prototype-grade hashing, replace with bcrypt server-side later
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return "h" + h.toString(36);
};

function toast(msg) {
  let wrap = $(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------------- Store (persistence layer) ---------------- */
const Store = {
  read(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  write(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  remove(key) { localStorage.removeItem(key); }
};

const K = {
  users: "sd_users",
  session: "sd_session",
  docs: (uidv) => "sd_docs_" + uidv,
  quiz: (uidv) => "sd_quiz_" + uidv,
  sessions: (uidv) => "sd_study_sessions_" + uidv
};

/* ---------------- Auth ---------------- */
const Auth = {
  users() { return Store.read(K.users, []); },
  saveUsers(u) { Store.write(K.users, u); },
  current() {
    const s = Store.read(K.session, null);
    if (!s) return null;
    const user = this.users().find(u => u.id === s.userId);
    if (!user) { Store.remove(K.session); return null; }
    return user;
  },
  roleOf(u) { return u && u.role === "teacher" ? "teacher" : "student"; },
  register(name, email, pw, role) {
    const users = this.users();
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase()))
      return { ok: false, error: "An account with this email already exists." };
    const user = {
      id: uid(), name: name.trim(), email: email.trim().toLowerCase(),
      pw: hashPw(pw), role: role === "teacher" ? "teacher" : "student", createdAt: Date.now(), tokens: 120, plan: "free"
    };
    users.push(user); this.saveUsers(users);
    Store.write(K.session, { userId: user.id });
    return { ok: true, user };
  },
  login(email, pw, remember, role) {
    if (!ROLES[role]) return { ok: false, error: "Choose Login as Student or Login as Teacher first." };
    const user = this.users().find(u => u.email === email.trim().toLowerCase());
    if (!user || user.pw !== hashPw(pw))
      return { ok: false, error: "Incorrect email or password." };
    if (this.roleOf(user) !== role) {
      const own = this.roleOf(user);
      return { ok: false, switchTo: own, error: "This account is registered as a " + own + ", not a " + role + "." };
    }
    if (remember) Store.write(K.session, { userId: user.id });
    else Store.write(K.session, { userId: user.id, temp: true });
    return { ok: true, user };
  },
  logout() {
    Store.remove(K.session);
    location.hash = "#/auth";
  },
  update(user) {
    const users = this.users().map(u => u.id === user.id ? user : u);
    this.saveUsers(users);
  }
};

/* ---------------- Documents ---------------- */
const Docs = {
  all() { const u = Auth.current(); return u ? Store.read(K.docs(u.id), []) : []; },
  save(list) { const u = Auth.current(); if (u) Store.write(K.docs(u.id), list); },
  get(id) { return this.all().find(d => d.id === id); },
  add(doc) { const l = this.all(); l.unshift(doc); this.save(l); },
  update(doc) { const l = this.all().map(d => d.id === doc.id ? doc : d); this.save(l); },
  remove(id) { this.save(this.all().filter(d => d.id !== id)); },
  touch(doc) { doc.lastStudied = Date.now(); this.update(doc); }
};

/* ---------------- Quiz attempts & study sessions ---------------- */
const Attempts = {
  all() { const u = Auth.current(); return u ? Store.read(K.quiz(u.id), []) : []; },
  add(a) { const u = Auth.current(); if (!u) return; const l = this.all(); l.unshift(a); Store.write(K.quiz(u.id), l); },
  forDoc(docId) { return this.all().filter(a => a.docId === docId); }
};
const Sessions = {
  all() { const u = Auth.current(); return u ? Store.read(K.sessions(u.id), []) : []; },
  add(docId, topicId, kind) {
    const u = Auth.current(); if (!u) return;
    const l = this.all();
    l.unshift({ id: uid(), docId, topicId, kind, at: Date.now() });
    Store.write(K.sessions(u.id), l.slice(0, 500));
  }
};

/* ============================================================
   CONTENT PACKS — realistic study material per subject area.
   Each topic: short explanation, key points, terms, structured
   deep dive, and quiz questions. Later this data comes from the
   LLM pipeline keyed off the extracted PDF text.
   ============================================================ */
const PACKS = {

programming: {
  subject: "Programming Fundamentals",
  topics: [
  {
    title: "Introduction to Programming",
    short: "Programming is the process of writing precise, step-by-step instructions that a computer can execute. A program is simply a set of these instructions, written in a programming language, that solves a specific problem.",
    keyPoints: [
      "A program is a sequence of instructions the computer executes one after another.",
      "An algorithm is a step-by-step problem-solving procedure written before any code.",
      "Every language has syntax — strict rules about how instructions must be written.",
      "A compiler or interpreter translates human-readable source code into machine code."
    ],
    terms: [
      { t: "Program", d: "A set of instructions that tells the computer what tasks to perform and in what order." },
      { t: "Algorithm", d: "A finite, ordered sequence of steps that solves a problem." },
      { t: "Syntax", d: "The grammatical rules of a programming language; code that breaks them will not run." },
      { t: "Compiler", d: "A tool that translates the entire source code into machine code before execution." }
    ],
    deepDive: [
      { h: "What a program really is", p: [
        "At its core, a program is a very obedient but very literal assistant. It does exactly what the instructions say — nothing more, nothing less. This is why programmers spend much of their time being precise: the machine will not guess your intent.",
        "Programs are built from simple building blocks: input (receiving data), processing (doing something with it), and output (showing or saving the result). Even large applications are combinations of these three ideas."
      ], why: "Every topic in this module — variables, control structures, functions — is just a more powerful way to organize these basic instructions." },
      { h: "From algorithm to code", p: [
        "Experienced programmers plan before they type. They write the algorithm first, often in plain language or pseudocode, and only then translate it into a real language."
      ], example: "Problem: compute the average of two numbers.\nAlgorithm: (1) get first number, (2) get second number, (3) add them, (4) divide by 2, (5) display the result.\nIn code this becomes just a few lines — but the thinking came first." },
      { h: "Why syntax matters", p: [
        "A missing semicolon or a mismatched bracket is not a small mistake to a compiler — it is a sentence it cannot parse at all. Learning a language's syntax early saves hours of frustrating errors later.",
        "Most modern editors highlight syntax errors as you type, which is why beginners are encouraged to use one instead of a plain text editor."
      ], check: { q: "True or false: the computer will figure out what you meant even if your syntax is wrong.", a: "False. The computer executes instructions literally and cannot infer intent — broken syntax means the program will not run." } }
    ],
    questions: [
      { q: "What is an algorithm?", opts: ["A type of computer hardware", "A step-by-step procedure for solving a problem", "A programming language", "A software license"], correct: 1, why: "An algorithm is a finite, ordered set of steps that solves a problem — it is language-independent and is planned before coding." },
      { q: "Which tool translates the entire source code into machine code before the program runs?", opts: ["Interpreter", "Compiler", "Web browser", "Operating system"], correct: 1, why: "A compiler translates the whole program ahead of time, while an interpreter translates line by line during execution." }
    ]
  },
  {
    title: "Variables and Data Types",
    short: "A variable is a named storage location that holds a value your program can use and change. Every value has a data type — such as number, text, or true/false — which tells the computer how to store and process it.",
    keyPoints: [
      "A variable pairs a name with a value so data can be reused and updated.",
      "Common data types: integers (whole numbers), floats (decimals), strings (text), and booleans (true/false).",
      "A value's type determines what operations are valid — you cannot do math on text.",
      "Variable names should be descriptive: 'quizScore' beats 'x'."
    ],
    terms: [
      { t: "Variable", d: "A named container that stores a value which can change while the program runs." },
      { t: "Integer", d: "A whole-number data type, e.g. 42 or -7." },
      { t: "String", d: "A sequence of characters (text) treated as a single value, e.g. \"Knozen AI\"." },
      { t: "Boolean", d: "A data type with only two values: true or false." }
    ],
    deepDive: [
      { h: "Variables as labeled boxes", p: [
        "Picture memory as a wall of boxes. Declaring a variable means writing a label on one box; assigning a value means putting something inside. Reading the variable means looking inside the box.",
        "The label (name) lets your code refer to the value without knowing where the box actually is. Later, you can replace the contents — that is what makes the value 'variable'."
      ] },
      { h: "The common data types", p: [
        "Numbers split into integers (whole numbers) and floats (numbers with decimals). Text is stored as strings. Decisions are stored as booleans. Choosing the right type is not optional decoration — it controls what the program is allowed to do with the value."
      ], example: "int score = 92;\nfloat average = 91.5;\nString subject = \"Programming\";\nboolean passed = true;" },
      { h: "Type errors and why they matter", p: [
        "If you try to add the string \"5\" and the number 7, different languages respond differently — some concatenate into \"57\", others throw an error. Neither is what a careless programmer intended.",
        "Good habit: decide the type of each piece of data when you plan the program, not while you are debugging it."
      ], why: "Quizzes in this module love to ask which type a value like \"true\" or \"3.14\" belongs to — train your eye to recognize them instantly.", check: { q: "What data type is the value 3.14?", a: "A float (floating-point number), because it has a decimal part." } }
    ],
    questions: [
      { q: "What is the main purpose of a variable?", opts: ["To make the program run faster", "To store a value under a name so it can be reused and changed", "To print output to the screen", "To connect to the internet"], correct: 1, why: "Variables give values a name so the program can read and update them anywhere." },
      { q: "What data type is the value \"true\"?", opts: ["String", "Integer", "Boolean", "Float"], correct: 2, why: "\"true\" (without quotes) is a boolean — one of only two possible values: true or false." }
    ]
  },
  {
    title: "Control Structures: Conditionals and Loops",
    short: "Control structures decide which instructions run and how many times. Conditionals (if/else) let the program make decisions, while loops repeat instructions as long as a condition holds — together they give programs their flexibility.",
    keyPoints: [
      "An if statement runs a block of code only when its condition is true.",
      "else and else-if handle the cases where the condition is false.",
      "A while loop repeats while a condition is true; a for loop repeats a known number of times.",
      "Loops need a way to end — an endless loop will hang the program."
    ],
    terms: [
      { t: "Conditional", d: "A structure (if/else) that executes code only when a condition is true." },
      { t: "Loop", d: "A structure that repeats a block of code multiple times." },
      { t: "Iteration", d: "One single pass through a loop's body." },
      { t: "Boolean expression", d: "An expression that evaluates to true or false, used as a condition." }
    ],
    deepDive: [
      { h: "Making decisions with if/else", p: [
        "Real programs must react differently to different situations: a passing grade prints congratulations, a failing grade prints a reminder. The if statement expresses this branching.",
        "Conditions are boolean expressions — comparisons like score >= 75 or status == \"active\". The program evaluates the condition and follows exactly one branch."
      ], example: "if (score >= 75) {\n  System.out.println(\"Passed\");\n} else {\n  System.out.println(\"Try again\");\n}" },
      { h: "Repeating work with loops", p: [
        "If you need to process 30 quiz items, you write the processing code once and let a loop run it 30 times. This is the single biggest shortcut in programming.",
        "Choose the loop by what you know: a for loop when you know the count, a while loop when you only know the stopping condition."
      ] },
      { h: "Infinite loops and safe counting", p: [
        "Every loop must move toward its end condition. A while loop whose condition never becomes false runs forever and freezes the program.",
        "Common safeguards: incrementing a counter each iteration, and setting a hard limit on attempts."
      ], check: { q: "A loop should print numbers 1 to 5. What must change inside the loop so it eventually stops?", a: "The counter variable must increase (or decrease) each iteration so the condition becomes false after 5 iterations." } }
    ],
    questions: [
      { q: "What does an if statement do?", opts: ["Repeats code forever", "Runs a block of code only when a condition is true", "Declares a variable", "Imports a library"], correct: 1, why: "Conditionals branch: the code inside if runs only when its boolean condition evaluates to true." },
      { q: "Which loop is the best choice when you know exactly how many times to repeat?", opts: ["while loop", "for loop", "if statement", "switch statement"], correct: 1, why: "A for loop bundles the counter, condition, and increment in one line — ideal for a known number of iterations." }
    ]
  },
  {
    title: "Functions",
    short: "A function is a named, reusable block of code that performs one specific task. Functions receive inputs (parameters), do their work, and can send back a result (return value), which keeps large programs organized.",
    keyPoints: [
      "A function groups instructions under one name so they can be reused anywhere.",
      "Parameters are the inputs a function receives; the return value is its output.",
      "Defining a function does not run it — you must call it.",
      "Small, single-purpose functions are easier to test and debug."
    ],
    terms: [
      { t: "Function", d: "A named block of code designed to perform a specific, reusable task." },
      { t: "Parameter", d: "An input variable declared by a function to receive values." },
      { t: "Return value", d: "The result a function sends back to the code that called it." },
      { t: "Scope", d: "The region of a program where a variable is visible and accessible." }
    ],
    deepDive: [
      { h: "Why functions exist", p: [
        "Without functions, a program is one long script where the same logic gets copied and pasted. When the logic needs fixing, every copy must be found and fixed — mistakes are guaranteed.",
        "A function captures that logic once. Every place that needs it simply calls the function by name."
      ] },
      { h: "Inputs, outputs, and the return statement", p: [
        "Parameters let one function handle many situations: a computeAverage(a, b) works for any two numbers, not just two specific ones.",
        "The return statement does two things at once: it ends the function and hands a value back to the caller."
      ], example: "int square(int n) {\n  return n * n;\n}\n// square(6) gives back 36" },
      { h: "Scope: where variables live", p: [
        "Variables declared inside a function generally exist only while that function runs. This isolation is a feature: functions cannot accidentally corrupt each other's data.",
        "The trade-off to remember: a function cannot see another function's local variables unless they are passed in as parameters."
      ], check: { q: "What is the difference between a parameter and a return value?", a: "A parameter is data sent into the function; a return value is data the function sends back out." } }
    ],
    questions: [
      { q: "What is the main benefit of using functions?", opts: ["They make programs run without electricity", "They allow code to be reused and organized", "They replace the need for variables", "They automatically fix syntax errors"], correct: 1, why: "Functions capture logic once under a name, so it can be called from anywhere and maintained in one place." },
      { q: "What does a return statement do?", opts: ["Restarts the program", "Ends the function and sends a value back to the caller", "Deletes the function", "Prints text to the screen"], correct: 1, why: "return both exits the function immediately and passes its result back to whoever called it." }
    ]
  },
  {
    title: "Arrays and Lists",
    short: "An array stores many values of the same type under one name, with each slot accessed by its index. Instead of creating 30 separate variables, you create one array and reach any element by its position number.",
    keyPoints: [
      "An array holds multiple values in a single, ordered structure.",
      "Each element is accessed by its index, starting at 0 in most languages.",
      "The length of an array is fixed at creation in many languages.",
      "Loops pair naturally with arrays to process every element."
    ],
    terms: [
      { t: "Array", d: "An ordered collection of same-type values stored under one name." },
      { t: "Index", d: "The numeric position of an element in an array; usually starts at 0." },
      { t: "Element", d: "A single value stored in one slot of an array." },
      { t: "Length", d: "The number of elements an array contains." }
    ],
    deepDive: [
      { h: "One name, many slots", p: [
        "Think of an array as a row of numbered mailboxes under one address. quizScores[0] is the first mailbox, quizScores[1] the second, and so on.",
        "The numbering from zero trips up every beginner: the first element is index 0, so the last element of a 10-item array is index 9."
      ], example: "int[] quizScores = {85, 92, 78, 90};\nquizScores[1]  // -> 92 (the SECOND score)" },
      { h: "Processing arrays with loops", p: [
        "Arrays and loops are a natural pair. A for loop that counts from 0 to length-1 can visit every element in order — sum them, find the highest, print each one.",
        "Going one past the end of the array is one of the most common errors in programming and causes an 'index out of bounds' exception."
      ] },
      { h: "Fixed vs. dynamic size", p: [
        "Classic arrays have a fixed length set at creation. Dynamic structures like ArrayList grow as you add items — useful when you do not know the count in advance, at a small performance cost.",
        "Rule of thumb for exams: fixed and fast, choose an array; unknown size, choose a list."
      ], check: { q: "An array has 10 elements. What is the index of its LAST element?", a: "Index 9 — indexing starts at 0, so a 10-element array spans indexes 0 through 9." } }
    ],
    questions: [
      { q: "In most programming languages, the first element of an array is at index...", opts: ["1", "0", "-1", "It depends on the element"], correct: 1, why: "Indexing starts at 0 in most languages (C, Java, Python, JavaScript), so element 1 sits at index 0." },
      { q: "Why are loops commonly used with arrays?", opts: ["Loops make arrays larger", "A loop can visit and process every element without writing code for each one", "Arrays cannot be used without loops", "Loops convert arrays into strings"], correct: 1, why: "A single loop iterates over indexes 0 to length-1, applying the same logic to each element." }
    ]
  },
  {
    title: "Debugging and Testing",
    short: "Debugging is the systematic process of finding and fixing errors in a program. Testing checks that the program behaves correctly, while tools like breakpoints and print statements help locate where things go wrong.",
    keyPoints: [
      "A bug is an error in a program; debugging is the work of finding and fixing it.",
      "Syntax errors are caught before running; logic errors run but produce wrong results.",
      "A breakpoint pauses execution so you can inspect variable values mid-run.",
      "Test cases should include normal, edge, and invalid inputs."
    ],
    terms: [
      { t: "Bug", d: "An error, flaw, or mistake in a program that causes incorrect behavior." },
      { t: "Debugging", d: "The process of locating, understanding, and fixing bugs." },
      { t: "Breakpoint", d: "A marker that pauses program execution at a specific line for inspection." },
      { t: "Test case", d: "A specific set of inputs and the expected output, used to verify correctness." }
    ],
    deepDive: [
      { h: "Two families of errors", p: [
        "Syntax errors break the language's grammar rules — the program will not even start. The compiler or editor usually points at them, so they are annoying but easy to find.",
        "Logic errors are sneakier: the program runs to completion but gives wrong answers. These require tracing the program's actual behavior against what you intended."
      ] },
      { h: "A systematic debugging routine", p: [
        "Resist the urge to change ten things at once. Reproduce the bug reliably, then narrow down: where does actual behavior first diverge from expected?",
        "The classic tools are print statements (log values at key points) and breakpoints (pause and inspect). Both answer the same question: what does the program actually see at this moment?"
      ], example: "Expected: average of 80 and 90 is 85.\nProgram prints 8090.\nDiagnosis: values were concatenated as strings, not added as numbers — a type problem, not a math problem." },
      { h: "Testing before and after", p: [
        "A good test suite covers three situations: normal inputs (the happy path), edge cases (empty input, zero, maximum values), and invalid inputs (wrong types, negative counts).",
        "After fixing a bug, rerun all old tests — a fix that breaks something else is called a regression, and it is more common than you would think."
      ], check: { q: "Your program runs without errors but computes the wrong total. What kind of error is this?", a: "A logic error — the syntax is fine, but the instructions do not express the intended computation." } }
    ],
    questions: [
      { q: "What is the purpose of a breakpoint?", opts: ["To delete a line of code", "To pause execution at a line so variables can be inspected", "To speed up the program", "To convert source code to machine code"], correct: 1, why: "Breakpoints freeze execution mid-run so a debugger can show the values of variables at that exact point." },
      { q: "What should be the first step in debugging a logic error?", opts: ["Rewrite the whole program", "Reproduce the bug reliably and identify where behavior diverges from expectation", "Add more features", "Delete all comments"], correct: 1, why: "A bug you can reproduce consistently is a bug you can measure — narrowing the divergence point tells you where to look." }
    ]
  }
  ]
},

history: {
  subject: "Philippine History",
  topics: [
  {
    title: "Pre-Colonial Philippines",
    short: "Before Spanish contact in 1521, the islands were organized into independent barangays led by datus, with established trade routes to China and Southeast Asia, and writing systems such as baybayin already in use.",
    keyPoints: [
      "The barangay, led by a datu, was the basic political unit of pre-colonial society.",
      "Trade with China, Borneo, and the Moluccas flourished long before 1521.",
      "Baybayin was a syllabic script used to write the local languages.",
      "Society was stratified into nobles (maharlika), freemen (timawa), and dependents (alipin)."
    ],
    terms: [
      { t: "Barangay", d: "A small coastal or riverine community, typically 30–100 families, governed by a datu." },
      { t: "Datu", d: "The chieftain and ruler of a barangay, combining political, judicial, and military authority." },
      { t: "Baybayin", d: "A pre-colonial syllabic writing system used in Luzon and the Visayas." },
      { t: "Timawa", d: "The freemen class — warriors and community members who owed allegiance to the datu." }
    ],
    deepDive: [
      { h: "The barangay as political unit", p: [
        "Pre-colonial Philippines had no single unified state. Each barangay was autonomous, governing its own affairs under a datu whose authority rested on birth, wealth, and martial skill.",
        "Justice was community-based: disputes were settled by the datu with elders advising, and penalties often took the form of compensation rather than imprisonment."
      ] },
      { h: "Trade and cultural contact", p: [
        "Archaeological finds — Chinese ceramics, goldwork, and imported beads — show the islands sat on busy trade routes. Ports like Manila, Cebu, and Butuan traded with China as early as the Song dynasty.",
        "These exchanges brought more than goods: loanwords, technology, and ideas moved along the same routes, shaping local cultures well before Europe arrived."
      ], example: "The Laguna Copperplate Inscription (900 CE) — the oldest written document found in the islands — records a debt cleared in gold, proving a literate, legally organized society nearly 600 years before colonization." },
      { h: "Social structure and class", p: [
        "Class determined duty. The maharlika were the warrior nobility, the timawa freemen who rowed and fought for the datu, and the alipin were dependents whose status ranged from tenant laborers to trusted household servants.",
        "Importantly, alipin status was not identical to chattel slavery elsewhere: some could own property, and obligations were often reciprocal."
      ], check: { q: "What was the basic political unit of pre-colonial Philippine society?", a: "The barangay — an independent community governed by a datu." } }
    ],
    questions: [
      { q: "Who led a pre-colonial barangay?", opts: ["A Spanish governor", "A datu", "A sultan elected by vote", "A Catholic friar"], correct: 1, why: "Each barangay was ruled by a datu, whose power combined political, judicial, and military leadership." },
      { q: "Baybayin is best described as...", opts: ["A pre-colonial syllabic writing system", "A type of boat", "A mountain range", "A Spanish legal code"], correct: 0, why: "Baybayin was the syllabic script used to write local languages before and during the early colonial period." }
    ]
  },
  {
    title: "Spanish Colonization (1565–1898)",
    short: "Spain ruled the Philippines for over three centuries through a centralized colonial government headed by the Governor-General, enforced locally through friars and the encomienda system, and justified through the twin goals of 'God, gold, and glory.'",
    keyPoints: [
      "Miguel López de Legazpi established the first permanent Spanish settlement in Cebu in 1565.",
      "The Governor-General, appointed by the Spanish Crown, held supreme civil and military authority.",
      "The encomienda granted colonizers the right to collect tribute from communities.",
      "Friars became the most powerful local figures, controlling education, records, and daily life."
    ],
    terms: [
      { t: "Encomienda", d: "A grant giving a Spaniard the right to collect tribute from a community in exchange for supposed protection and instruction." },
      { t: "Governor-General", d: "The Crown's highest representative in the colony, combining executive, legislative, and military power." },
      { t: "Friarocracy", d: "The immense informal power of religious orders over colonial administration and daily life." },
      { t: "Tribute", d: "A mandatory tax paid by indios to the colonial state, often in cash, goods, or labor." }
    ],
    deepDive: [
      { h: "How the colony was run", p: [
        "Power flowed vertically: the Governor-General in Manila ruled by decree, provincial officials (alcaldes mayores and corregidores) enforced policies, and at the base sat the friar — often the only Spaniard a villager ever met.",
        "This fusion of church and state meant resisting one meant resisting both, which shaped every later reform and revolt."
      ] },
      { h: "The encomienda and its abuses", p: [
        "Encomenderos were meant to protect and Christianize their assigned communities. In practice, many collected tribute ruthlessly and provided nothing in return.",
        "The system faded legally by the 1700s, but its logic — extraction from indios for Spanish benefit — persisted through forced labor (polo y servicios) and monopolies."
      ], why: "Board exams frequently contrast the encomienda's stated purpose with its actual operation — memorize both sides." },
      { h: "Daily life under the friars", p: [
        "Friars ran parishes, schools, and censuses; they recommended (or blacklisted) local officials and recorded births, marriages, and deaths. A community could barely act without friar approval.",
        "Yet the friars also built churches, schools, and roads, and their records are today a priceless source of Philippine history — a complicated legacy examiners love to probe."
      ], check: { q: "Why were friars so influential in towns far from Manila?", a: "They were usually the only Spanish authority on the ground, controlling records, education, and endorsement of local officials." } }
    ],
    questions: [
      { q: "Who held the highest authority in the Spanish colonial government?", opts: ["The Archbishop of Manila", "The Governor-General", "The Encomendero General", "The Sultan of Sulu"], correct: 1, why: "The Governor-General, appointed by the Spanish Crown, combined supreme civil, military, and even legislative authority." },
      { q: "The encomienda system primarily allowed Spaniards to...", opts: ["Vote in colonial elections", "Collect tribute from assigned communities", "Trade freely with China", "Own land outright"], correct: 1, why: "Encomenderos collected tribute (tax) from communities in exchange for nominal protection and Christian instruction." }
    ]
  },
  {
    title: "The Propaganda Movement",
    short: "The Propaganda Movement (1872–1892) was a peaceful campaign by Filipino expatriates in Europe — led by Rizal, Marcelo del Pilar, and Graciano López Jaena — demanding reforms, equality, and representation through essays and novels rather than revolution.",
    keyPoints: [
      "It began after the 1872 Cavite Mutiny, which Spain used to execute priests Burgos, Gomez, and Zamora.",
      "The movement sought assimilation: Philippine representation in the Spanish Cortes and secularization of parishes.",
      "La Solidaridad was its newspaper; Noli Me Tangere and El Filibusterismo were its novels.",
      "It failed to win reforms, but it built the national consciousness that made the Revolution possible."
    ],
    terms: [
      { t: "Propaganda Movement", d: "A reformist campaign (1872–1892) by Filipino ilustrados seeking equality and reforms through writing." },
      { t: "Ilustrado", d: "An educated Filipino, often European-schooled, who led reformist and nationalist thought." },
      { t: "La Solidaridad", d: "The Barcelona/Madrid newspaper of the movement, edited at different times by its leading figures." },
      { t: "Secularization", d: "The demand that Philippine parishes be run by Filipino priests instead of Spanish friars." }
    ],
    deepDive: [
      { h: "From the Cavite Mutiny to reform", p: [
        "In 1872, workers at the Cavite arsenal revolted over tribute and labor grievances. Spain framed it as a separatist conspiracy and executed the priests Mariano Gomez, Jose Burgos, and Jacinto Zamora.",
        "The executions radicalized a generation. Paciano Mercado, brother of Rizal, was linked to Burgos — and the lesson the ilustrados drew was that Spain would not reform under pressure from below; it must be persuaded from within."
      ] },
      { h: "Tools of persuasion: pen, press, novel", p: [
        "The movement's weapon was print. La Solidaridad campaigned for Philippine representation in the Spanish Cortes, Philippine priests in parishes, and equal schooling.",
        "Rizal's Noli Me Tangere (1887) exposed colonial abuse through fiction — safer than pamphlets, and far more powerful. Its sequel, El Filibusterismo (1891), darkened the diagnosis: reform may already be too late."
      ], example: "Memorize the triad for exams: del Pilar — political essays and La Solidaridad; López Jaena — biting satire (Fray Botod); Rizal — the novels that became the movement's conscience." },
      { h: "Why it failed — and why it mattered anyway", p: [
        "Spain ignored every petition. Funding dried up, La Solidaridad closed in 1895, and del Pilar died in exile. By peaceful means, the movement had achieved almost nothing on paper.",
        "But it succeeded completely at the deeper goal: it gave Filipinos a shared identity and a common grievance. When Andrés Bonifacio founded the Katipunan in 1892, he was standing on ground the propagandists had already prepared."
      ], check: { q: "What event in 1872 directly triggered the Propaganda Movement?", a: "The Cavite Mutiny and the execution of GomBurZa, which radicalized Filipino reformists." } }
    ],
    questions: [
      { q: "The Propaganda Movement primarily sought...", opts: ["Immediate armed revolution", "Reforms and equality within Spain, such as representation in the Cortes", "American annexation", "Restoration of the barangay system"], correct: 1, why: "It was assimilationist — it demanded representation, secularization, and equality as a Spanish province, not independence." },
      { q: "Which newspaper served as the movement's official organ?", opts: ["Kalayaan", "La Solidaridad", "Diariong Tagalog", "The Philippines Free Press"], correct: 1, why: "La Solidaridad, published in Spain and edited at turns by del Pilar and others, carried the movement's essays and demands." }
    ]
  },
  {
    title: "The Philippine Revolution",
    short: "Founded by Andrés Bonifacio in 1892, the Katipunan launched the Revolution in 1896 after discovery by the friars. The movement survived internal rivalry — Bonifacio's execution, Aguinaldo's leadership — and proclaimed independence on June 12, 1898.",
    keyPoints: [
      "The Katipunan (KKK) was a secret society that prepared for independence by force of arms.",
      "The Revolution began in August 1896 after the Katipunan was discovered.",
      "Bonifacio was executed in 1897 after the Tejeros Convention; Aguinaldo took leadership.",
      "The June 12, 1898 proclamation at Kawit, Cavite declared Philippine independence."
    ],
    terms: [
      { t: "Katipunan", d: "The secret revolutionary society founded 1892 to win independence through armed struggle." },
      { t: "Cry of Pugad Lawin", d: "The tearing of cédulas in August 1896 — the traditional start of the Revolution." },
      { t: "Tejeros Convention", d: "The 1897 assembly that elected a revolutionary government, sidelining Bonifacio." },
      { t: "Pact of Biak-na-Bato", d: "The 1897 truce: Aguinaldo's exile to Hong Kong in exchange for Spanish reform promises Spain never kept." }
    ],
    deepDive: [
      { h: "The Katipunan: structure and spread", p: [
        "Bonifacio, a warehouse clerk who read the Noli and concluded reform was dead, founded the Katipunan with like-minded men from Tondo. Members recruited relatives and neighbors, and chapters spread across Luzon within four years.",
        "It was organized in three grades with passwords and rituals — secrecy was survival, since discovery meant execution for treason. Discovery came in August 1896 through a Katipunan sister's confession."
      ] },
      { h: "Bonifacio versus Aguinaldo", p: [
        "The Revolution succeeded militarily in Cavite under Emilio Aguinaldo, whose Magdalo faction rivaled Bonifacio's Magdiwang. At the Tejeros Convention, delegates elected Aguinaldo president — Bonifacio, feeling cheated, refused to recognize the result.",
        "Accused of treason, Bonifacio and his brother Procopio were executed in May 1897 at Maragondon. It remains the Revolution's deepest wound: the movement began by a clerk ended by the execution of its founder."
      ], why: "Exam standby: Tejeros Convention (March 1897), election of Aguinaldo, Bonifacio's execution (May 10, 1897) — dates and order matter." },
      { h: "Biak-na-Bato and the return", p: [
        "Broken by the truce of Biak-na-Bato, Aguinaldo accepted exile and payment — which Spain never fully delivered. Within months the truce collapsed and fighting resumed.",
        "In 1898, the American navy destroyed the Spanish fleet at Manila Bay and Aguinaldo returned with US support, rekindling the Revolution. On June 12, 1898, at his house in Kawit, independence was proclaimed and the Philippine flag unfurled for the first time."
      ], check: { q: "What was the Pact of Biak-na-Bato (1897)?", a: "A truce where Aguinaldo agreed to exile in Hong Kong in exchange for Spanish reform payments — promises Spain broke." } }
    ],
    questions: [
      { q: "Who founded the Katipunan in 1892?", opts: ["Jose Rizal", "Andrés Bonifacio", "Emilio Aguinaldo", "Apolinario Mabini"], correct: 1, why: "Bonifacio founded the Katipunan after concluding that peaceful reform, the path of the propagandists, had failed." },
      { q: "The Philippine independence was proclaimed on June 12, 1898 at...", opts: ["Malolos, Bulacan", "Kawit, Cavite", "Tejeros, Cavite", "Biak-na-Bato"], correct: 1, why: "Aguinaldo proclaimed independence from the window of his house in Kawit, Cavite — the act the holiday commemorates." }
    ]
  },
  {
    title: "The American Period (1898–1946)",
    short: "After the Spanish-American War, the US took control of the Philippines, defeating the First Philippine Republic in the Philippine-American War. The Americans established public schools, a civil service, and gradual self-government through the Commonwealth.",
    keyPoints: [
      "The Treaty of Paris (1898) transferred the Philippines from Spain to the US for $20 million.",
      "The Philippine-American War (1899–1902) crushed the First Republic.",
      "America's 'benevolent assimilation' brought mass public schooling and English instruction.",
      "The 1935 Commonwealth Constitution set a 10-year transition to full independence."
    ],
    terms: [
      { t: "Treaty of Paris (1898)", d: "The treaty ending the Spanish-American War; Spain ceded the Philippines to the US for $20 million." },
      { t: "Benevolent assimilation", d: "The US policy framing colonial rule as tutelage toward self-government." },
      { t: "Jones Law (1916)", d: "The US law promising Philippine independence once a stable government was established." },
      { t: "Commonwealth", d: "The 1935–1946 transitional government with Filipino elected officials under US sovereignty." }
    ],
    deepDive: [
      { h: "From one empire to another", p: [
        "Filipinos who fought beside the Americans against Spain discovered the US had other plans. The Philippine-American War began in February 1899 and was far bloodier than the Revolution — entire towns were pacified at enormous cost.",
        "By 1902 the republic was militarily broken, but the war never formally ended in a treaty; resistance continued in Muslim Mindanao for years."
      ] },
      { h: "Education as the American legacy", p: [
        "The single most transformative policy was mass public education. American teachers (the 'Thomasites,' arriving 1901) fanned out across the islands, and English became the medium of instruction.",
        "Within a generation, literacy rose sharply and an English-speaking Filipino professional class emerged — a deliberate strategy of 'benevolent assimilation' that also seeded Filipino nationalism in new forms."
      ], example: "For exams: remember the sequence of enabling laws — Philippine Bill of 1902 (civilian government), Jones Law of 1916 (independence promise), Tydings–McDuffie Act of 1934 (Commonwealth + 10-year timetable)." },
      { h: "The Commonwealth and the road cut short", p: [
        "The 1935 Constitution created the Commonwealth, with Manuel L. Quezon as first president. It operated like a full national government in waiting — organizing defense, finances, and the Tagalog-based national language.",
        "The ten-year countdown to 1946 was interrupted by war in 1941. Quezon died in exile in 1944; Sergio Osmeña led the government-in-exile until liberation and independence finally came on July 4, 1946."
      ], check: { q: "What did the Jones Law of 1916 promise?", a: "Philippine independence once a stable government was established — the first formal US commitment to eventual freedom." } }
    ],
    questions: [
      { q: "Under the Treaty of Paris (1898), Spain ceded the Philippines to the United States for...", opts: ["$20 million", "$2 million", "No payment — as war reparations", "Trade concessions only"], correct: 0, why: "Spain sold the Philippines to the US for $20 million, without any Filipino representative present — a fact nationalists never forgot." },
      { q: "The Commonwealth period (1935) was intended as...", opts: ["A permanent colonial status", "A 10-year transition to full independence", "A US statehood plebiscite", "A Japanese protectorate"], correct: 1, why: "The Tydings–McDuffie Act set up the Commonwealth as a decade-long transition, cut short by World War II but completed in 1946." }
    ]
  },
  {
    title: "World War II and Independence",
    short: "Japan occupied the Philippines from 1942 to 1945, inaugurating the wartime Republic and brutal occupations that fueled massive guerrilla resistance. Liberation came in 1945, and the Third Republic was inaugurated on July 4, 1946.",
    keyPoints: [
      "Japan invaded December 1941, days after Pearl Harbor; Bataan fell in April 1942.",
      "The Bataan Death March killed thousands of captured Filipino and American soldiers.",
      "The Japanese-sponsored Second Republic (1943–1945) had little legitimacy.",
      "Independence was proclaimed on July 4, 1946, with Manuel Roxas as first president."
    ],
    terms: [
      { t: "Bataan Death March", d: "The 65-mile forced march of ~75,000 POWs in April 1942; thousands died from abuse and exhaustion." },
      { t: "Guerrilla resistance", d: "Underground Filipino–American forces that harassed the Japanese and gathered intelligence." },
      { t: "Second Republic", d: "The 1943 Japanese-sponsored state under José P. Laurel, widely rejected as a puppet regime." },
      { t: "Third Republic", d: "The independent Philippine republic proclaimed July 4, 1946, ending American rule." }
    ],
    deepDive: [
      { h: "Occupation and atrocity", p: [
        "The invasion began hours after Pearl Harbor. US–Filipino forces made a heroic last stand on Bataan and Corregidor before surrendering in April–May 1942; the Bataan Death March that followed became the war's defining atrocity in Philippine memory.",
        "Manila, declared an open city, was occupied; the return of fighting in 1945 destroyed much of the capital and killed over 100,000 civilians in the month-long Battle of Manila alone."
      ] },
      { h: "Collaboration and resistance", p: [
        "The Japanese framed their rule as 'Asia for Asians' and installed a nominal republic under José P. Laurel in 1943. Most Filipinos saw it for what it was — a puppet — while guerrilla movements, supplied by submarines and radios, controlled much of the countryside by 1944.",
        "This produced the war's thorniest postwar question: who collaborated? The issue poisoned politics for a decade, and wartime leader Manuel Roxas won the 1946 presidency partly on promises to move past it."
      ], why: "A frequent essay prompt: compare the legitimacy of the Second Republic (Japanese-sponsored) with the Commonwealth government-in-exile — one had elections, the other had bayonets." },
      { h: "Liberation and the birth of the Republic", p: [
        "General MacArthur returned in October 1944, landing at Leyte. By mid-1945 the islands were liberated at staggering cost — the Philippines had suffered among the highest civilian death rates of the war.",
        "On July 4, 1946, in ceremonies at Luneta, the American flag came down and the Philippine flag rose. Manuel Roxas took his oath as the first president of the Third Republic — finally, a republic Filipinos did not have to share."
      ], check: { q: "Why did the Japanese-sponsored Second Republic (1943) lack legitimacy?", a: "It was created and controlled by an occupying power without genuine Filipino consent — widely regarded as a puppet regime." } }
    ],
    questions: [
      { q: "The Bataan Death March (April 1942) involved...", opts: ["Japanese civilians evacuating Manila", "Forced march of Filipino and American POWs after Bataan's fall", "American forces retreating to Corregidor", "Food convoys to occupied Cebu"], correct: 1, why: "Around 75,000 captured soldiers were force-marched 65 miles; thousands died, making it a symbol of Japanese wartime cruelty." },
      { q: "The Third Republic was inaugurated on...", opts: ["June 12, 1898", "July 4, 1946", "September 21, 1972", "February 25, 1986"], correct: 1, why: "July 4, 1946 marks formal independence from the US and the start of the Third Republic under President Manuel Roxas." }
    ]
  }
  ]
},

biology: {
  subject: "Biology",
  topics: [
  {
    title: "Cell Structure",
    short: "The cell is the basic unit of life. Every organism is made of cells, and each cell is organized into specialized structures called organelles — each with a distinct job that keeps the cell alive.",
    keyPoints: [
      "The cell membrane controls what enters and leaves the cell.",
      "The nucleus holds DNA, the cell's genetic instructions.",
      "Mitochondria produce energy (ATP) through cellular respiration.",
      "Plant cells add a cell wall, chloroplasts, and a large central vacuole."
    ],
    terms: [
      { t: "Organelle", d: "A specialized structure inside a cell that performs a specific function." },
      { t: "Nucleus", d: "The membrane-bound structure containing the cell's DNA and controlling its activities." },
      { t: "Mitochondrion", d: "The organelle that generates ATP, the cell's energy currency." },
      { t: "Cytoplasm", d: "The jelly-like substance filling the cell where organelles are suspended." }
    ],
    deepDive: [
      { h: "The two great cell types", p: [
        "Prokaryotic cells (bacteria) have no nucleus — their DNA floats freely. Eukaryotic cells (plants, animals, fungi) keep DNA inside a nucleus and pack their machinery into organelles.",
        "Every organelle you memorize is a division of labor: rather than chemistry happening everywhere at random, each reaction is assigned a dedicated workspace."
      ] },
      { h: "Organelles and their jobs", p: [
        "The nucleus is command central: it stores DNA, which carries the instructions for building every protein. The nucleolus inside it makes ribosomes, the protein factories.",
        "Mitochondria burn sugar and oxygen to produce ATP. Ribosomes read genetic instructions and assemble proteins; the endoplasmic reticulum and Golgi apparatus fold, modify, and ship those proteins where needed."
      ], example: "Memory hook for exams — 'powerhouse of the cell' = mitochondria; 'control center' = nucleus; 'protein factories' = ribosomes; 'shipping department' = Golgi apparatus." },
      { h: "Plant versus animal cells", p: [
        "Plant cells have three structures animal cells lack: a rigid cell wall of cellulose for support, chloroplasts for photosynthesis, and a large central vacuole that stores water and pushes the membrane outward to keep the cell firm.",
        "Both share the core set: membrane, nucleus, mitochondria, ribosomes, ER, and Golgi."
      ], check: { q: "Which organelle is found in plant cells but not in animal cells?", a: "Chloroplasts (also the cell wall and large central vacuole — any of these earns the point)." } }
    ],
    questions: [
      { q: "Which organelle is known as the powerhouse of the cell?", opts: ["Nucleus", "Ribosome", "Mitochondrion", "Golgi apparatus"], correct: 2, why: "Mitochondria generate ATP, the energy currency the cell spends on all its activities." },
      { q: "What is the main function of the cell membrane?", opts: ["To produce energy", "To control what enters and leaves the cell", "To store DNA", "To make proteins"], correct: 1, why: "The selectively permeable membrane regulates the passage of substances, keeping the inside distinct from the environment." }
    ]
  },
  {
    title: "Cell Membrane and Transport",
    short: "The cell membrane is a selectively permeable phospholipid bilayer that controls the movement of substances. Materials cross it by passive transport (no energy needed, moving with the gradient) or active transport (energy needed, moving against it).",
    keyPoints: [
      "The membrane is a phospholipid bilayer with embedded proteins.",
      "Diffusion moves substances from high to low concentration — no energy required.",
      "Osmosis is the diffusion of water across a selectively permeable membrane.",
      "Active transport moves substances against the gradient using ATP and protein pumps."
    ],
    terms: [
      { t: "Selective permeability", d: "The membrane property of allowing some substances to pass while blocking others." },
      { t: "Diffusion", d: "Passive movement of particles from an area of higher to lower concentration." },
      { t: "Osmosis", d: "The diffusion of water across a selectively permeable membrane." },
      { t: "Active transport", d: "Movement of substances against the concentration gradient, powered by ATP." }
    ],
    deepDive: [
      { h: "Anatomy of the membrane", p: [
        "The phospholipid bilayer arranges itself with water-loving heads facing the watery environments inside and outside the cell, and water-fearing tails hidden in the middle. This self-sealing sheet is the foundation of the cell's border.",
        "Membrane proteins act as channels, carriers, and receptors — they decide which molecules get a doorway and which signals the cell hears."
      ] },
      { h: "Passive transport: going downhill", p: [
        "Diffusion needs no energy because molecules naturally spread out. Oxygen diffuses into cells; carbon dioxide diffuses out. The steeper the concentration gradient, the faster the movement.",
        "Osmosis follows the same logic for water. If the outside solution is saltier than the cytoplasm, water rushes out and the cell shrivels. The classic exam scenario: a red blood cell in distilled water swells and may burst."
      ], example: "Isotonic (equal salt) — cell normal. Hypotonic (less salt outside) — water enters, cell swells. Hypertonic (more salt outside) — water leaves, cell shrivels." },
      { h: "Active transport: spending energy to climb", p: [
        "Sometimes the cell needs more of something than the gradient provides — like pulling glucose from the gut when blood levels are already low. Protein pumps grab the molecule on one side, change shape using ATP, and release it on the other.",
        "Sodium-potassium pumps, running constantly in nerve cells, maintain the electrical gradients that make signals possible."
      ], check: { q: "A cell needs to take in a molecule that is already more concentrated inside than outside. Which transport is required?", a: "Active transport — moving against the gradient requires a protein pump and ATP." } }
    ],
    questions: [
      { q: "Osmosis refers specifically to the diffusion of...", opts: ["Oxygen", "Water", "Salt", "Proteins"], correct: 1, why: "Osmosis is defined as the movement of water molecules across a selectively permeable membrane." },
      { q: "Active transport differs from diffusion because it...", opts: ["Moves substances against the gradient and requires ATP", "Requires no energy", "Only moves water", "Happens only in plant cells"], correct: 0, why: "Active transport moves substances from low to high concentration using energy from ATP and protein pumps." }
    ]
  },
  {
    title: "Photosynthesis",
    short: "Photosynthesis is the process by which plants, algae, and some bacteria convert light energy into chemical energy stored in glucose. It takes place in chloroplasts, using carbon dioxide, water, and sunlight, and releases oxygen as a byproduct.",
    keyPoints: [
      "Overall equation: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.",
      "The light-dependent reactions occur in the thylakoid membranes and produce ATP and NADPH.",
      "The Calvin cycle (light-independent) occurs in the stroma and builds glucose.",
      "Chlorophyll absorbs mainly red and blue light, reflecting green."
    ],
    terms: [
      { t: "Chlorophyll", d: "The green pigment in chloroplasts that captures light energy." },
      { t: "Thylakoid", d: "The membrane-bound disc inside chloroplasts where light reactions occur." },
      { t: "Calvin cycle", d: "The light-independent reactions that fix carbon dioxide into glucose." },
      { t: "Stroma", d: "The fluid filling the chloroplast where the Calvin cycle takes place." }
    ],
    deepDive: [
      { h: "The two stages, in order", p: [
        "Stage one, the light-dependent reactions, need light directly. They occur on the thylakoid membranes, split water molecules (releasing oxygen), and capture the energy in ATP and NADPH.",
        "Stage two, the Calvin cycle, does not need light directly — it needs the products of stage one. In the stroma, carbon dioxide is stitched into a growing sugar molecule, powered by the stored ATP and NADPH."
      ], why: "The exam trap: 'light-independent' does not mean 'happens in the dark' — the cycle depends on the ATP and NADPH that only light reactions produce." },
      { h: "Where the oxygen comes from", p: [
        "Early researchers assumed the O₂ came from CO₂. Labeled-water experiments proved the opposite: the oxygen released during photosynthesis comes from splitting water (H₂O).",
        "This matters beyond trivia — the oxygen in every breath you take traces back to water split by ancient photosynthesizers."
      ] },
      { h: "Why plants are green", p: [
        "Chlorophyll absorbs light most strongly in the red and blue ends of the spectrum. Green light is reflected instead of absorbed — which is why leaves look green.",
        "Accessory pigments (carotenoids, giving autumn yellows) broaden the range of light a plant can harvest and protect chlorophyll from excess light."
      ], check: { q: "Where in the chloroplast does the Calvin cycle occur?", a: "In the stroma, the fluid surrounding the thylakoids." } }
    ],
    questions: [
      { q: "The oxygen released during photosynthesis comes from...", opts: ["Carbon dioxide", "Glucose", "Water", "The atmosphere"], correct: 2, why: "Water molecules are split during the light reactions, and the oxygen atoms released come from H₂O, not CO₂." },
      { q: "The light-dependent reactions of photosynthesis occur in the...", opts: ["Stroma", "Thylakoid membranes", "Mitochondria", "Nucleus"], correct: 1, why: "The thylakoid membranes hold the chlorophyll and protein complexes that capture light and produce ATP and NADPH." }
    ]
  },
  {
    title: "Cellular Respiration",
    short: "Cellular respiration releases the energy stored in glucose, converting it into ATP. It occurs in three stages — glycolysis, the Krebs cycle, and the electron transport chain — mostly inside the mitochondria, and uses the oxygen we breathe.",
    keyPoints: [
      "Overall: C₆H₁₂O₆ + 6O₂ → 6CO₂ + 6H₂O + ATP (about 36–38 ATP).",
      "Glycolysis happens in the cytoplasm and splits glucose into two pyruvate.",
      "The Krebs cycle and electron transport chain occur in the mitochondria.",
      "Without oxygen, cells fall back on fermentation, yielding only 2 ATP."
    ],
    terms: [
      { t: "Glycolysis", d: "The first stage of respiration; splits one glucose into two pyruvate in the cytoplasm." },
      { t: "Krebs cycle", d: "The mitochondrial cycle that harvests high-energy electrons from pyruvate." },
      { t: "Electron transport chain", d: "The final stage, using electrons to pump protons and mass-produce ATP." },
      { t: "Fermentation", d: "Anaerobic ATP production that regenerates NAD⁺, yielding only 2 ATP per glucose." }
    ],
    deepDive: [
      { h: "Three stages, two locations", p: [
        "Glycolysis happens in the cytoplasm, outside the mitochondria — evidence of its ancient origin. It produces a modest 2 ATP and 2 NADH per glucose.",
        "The real harvest happens inside the mitochondria: the Krebs cycle strips electrons from the pyruvate remains, and the electron transport chain uses those electrons — with oxygen as the final acceptor — to generate roughly 34 more ATP."
      ], example: "ATP math exams love: glycolysis = 2 ATP, full aerobic respiration ≈ 36–38 ATP. Aerobic respiration is roughly 18× more efficient than fermentation." },
      { h: "Why oxygen is essential", p: [
        "The electron transport chain cannot run without a final electron acceptor. Oxygen plays that role; without it, the chain backs up like a conveyor belt hitting a wall.",
        "Cells then rely on fermentation, which regenerates the NAD⁺ glycolysis needs but produces only 2 ATP. Muscle burn during intense exercise is the price of ATP bought on credit."
      ] },
      { h: "Photosynthesis and respiration: mirror images", p: [
        "Compare the equations and you will see the same molecules on opposite sides. Photosynthesis stores light energy in glucose; respiration cashes that glucose back into ATP.",
        "Notice the elegant loop: the CO₂ you exhale is a plant's raw material, and the O₂ a plant releases is your final electron acceptor."
      ], check: { q: "Which stage of respiration produces the most ATP?", a: "The electron transport chain — it accounts for the vast majority (about 34) of the ~36–38 ATP." } }
    ],
    questions: [
      { q: "Glycolysis takes place in the...", opts: ["Mitochondrial matrix", "Cytoplasm", "Nucleus", "Thylakoid"], correct: 1, why: "Glycolysis occurs in the cytoplasm; only the later stages (Krebs cycle, electron transport chain) occur in the mitochondria." },
      { q: "Approximately how many ATP are produced from one glucose molecule in aerobic respiration?", opts: ["2", "4", "10", "36–38"], correct: 3, why: "Full aerobic respiration yields about 36–38 ATP, versus only 2 ATP from glycolysis or fermentation alone." }
    ]
  },
  {
    title: "DNA and Genes",
    short: "DNA is a double-stranded helix that stores genetic instructions in the sequence of its bases — adenine, thymine, guanine, and cytosine. A gene is a segment of DNA that codes for a protein, and its sequence of bases spells out the recipe.",
    keyPoints: [
      "DNA's shape is a double helix, described by Watson and Crick in 1953.",
      "Base pairing: A pairs with T, G pairs with C — held by hydrogen bonds.",
      "A gene is a DNA segment that codes for a specific protein.",
      "DNA replicates semi-conservatively: each new molecule keeps one old strand."
    ],
    terms: [
      { t: "Nucleotide", d: "The building block of DNA: a sugar, a phosphate, and a nitrogenous base." },
      { t: "Double helix", d: "The twisted-ladder shape of the DNA molecule." },
      { t: "Gene", d: "A segment of DNA that contains the instructions for building a protein." },
      { t: "Base pairing", d: "The specific pairing of A–T and G–C across the two DNA strands." }
    ],
    deepDive: [
      { h: "Structure of the molecule", p: [
        "Each strand is a chain of nucleotides: deoxyribose sugar, phosphate group, and one of four bases. The phosphates and sugars form the backbone; the bases point inward like rungs of a ladder.",
        "Two strands twist into a helix, running in opposite directions, with bases pairing across the middle: adenine with thymine (two hydrogen bonds), guanine with cytosine (three)."
      ], example: "If one strand reads A-T-G-C-C, its partner must read T-A-C-G-G. Given one strand, you can always write the other — a guaranteed exam question." },
      { h: "From gene to protein", p: [
        "A gene is a recipe. In transcription, the recipe is copied into messenger RNA; in translation, ribosomes read the mRNA three bases at a time and assemble the corresponding amino acids into a protein.",
        "The DNA stays safe in the nucleus; mRNA is the working copy that travels to the ribosomes."
      ] },
      { h: "How DNA copies itself", p: [
        "Replication begins when enzymes unzip the helix. Each old strand then serves as the template for a new complementary strand, assembled according to base-pairing rules.",
        "The result: two identical DNA molecules, each with one original strand and one new strand — semi-conservative replication, proven by the Meselson–Stahl experiment."
      ], check: { q: "If a DNA strand has the sequence A-G-C-T, what is its complementary strand?", a: "T-C-G-A — A pairs with T, and G pairs with C." } }
    ],
    questions: [
      { q: "In DNA, adenine pairs with...", opts: ["Guanine", "Cytosine", "Thymine", "Uracil"], correct: 2, why: "A pairs with T (two hydrogen bonds); G pairs with C (three hydrogen bonds). Uracil replaces thymine only in RNA." },
      { q: "A gene is best defined as...", opts: ["An entire chromosome", "A DNA segment coding for a protein", "A type of protein", "The cell membrane"], correct: 1, why: "A gene is a specific stretch of DNA whose base sequence encodes the instructions for one protein (or functional RNA)." }
    ]
  },
  {
    title: "Genetics: Mendel and Heredity",
    short: "Gregor Mendel discovered the basic rules of heredity by crossing pea plants. Traits are passed by discrete units (genes) in dominant and recessive versions (alleles), and his laws of segregation and independent assortment predict how traits appear in offspring.",
    keyPoints: [
      "Mendel worked with pea plants and tracked traits across generations mathematically.",
      "Dominant alleles mask recessive ones; recessive traits appear only with two recessive alleles.",
      "Law of segregation: allele pairs separate during gamete formation.",
      "Law of independent assortment: genes for different traits assort independently of each other."
    ],
    terms: [
      { t: "Allele", d: "One of the alternative versions of a gene (e.g., the allele for purple vs. white flowers)." },
      { t: "Dominant", d: "An allele that expresses its trait even when only one copy is present." },
      { t: "Recessive", d: "An allele whose trait appears only when no dominant allele is present." },
      { t: "Genotype / Phenotype", d: "The genetic makeup of an organism / the observable traits it displays." }
    ],
    deepDive: [
      { h: "Mendel's method", p: [
        "Mendel chose pea plants because they grow fast, produce many offspring, and have clear-cut traits. He started with pure-breeding lines, then crossed them and counted the offspring generation after generation.",
        "His crucial insight was statistical: traits did not blend — they reappeared in fixed ratios. From these ratios he inferred invisible factors, which we now call genes."
      ] },
      { h: "Reading a Punnett square", p: [
        "A monohybrid cross of two heterozygotes (Tt × Tt) yields genotype ratio 1 TT : 2 Tt : 1 tt, which appears as 3 dominant : 1 recessive offspring.",
        "The testcross — crossing an unknown dominant-phenotype plant with a recessive one — reveals whether the unknown is TT or Tt by the offspring it produces."
      ], example: "Tall (T) is dominant over short (t). Tt × Tt → 25% TT, 50% Tt, 25% tt. Phenotypes: 75% tall, 25% short." },
      { h: "The two laws", p: [
        "Law of segregation: the two alleles for a trait separate when gametes form, so each sperm or egg carries only one. Offspring receive one allele from each parent.",
        "Law of independent assortment: alleles of different genes (say, seed shape and seed color) are inherited independently — provided the genes are on different chromosomes. This is why offspring show new trait combinations."
      ], check: { q: "Two heterozygous tall plants (Tt) are crossed. What fraction of offspring will be short?", a: "1/4 (25%) — the cross gives 1 TT : 2 Tt : 1 tt, and only tt shows the recessive short trait." } }
    ],
    questions: [
      { q: "A recessive trait appears in offspring only when...", opts: ["One parent shows the trait", "Both alleles for the trait are recessive", "The trait is dominant in the other parent", "Mutation occurs"], correct: 1, why: "Recessive alleles are masked by dominant ones; the recessive phenotype requires two recessive alleles (e.g., tt)." },
      { q: "Mendel's law of segregation states that...", opts: ["Traits blend in offspring", "Allele pairs separate during gamete formation", "All traits are dominant", "Genes mutate each generation"], correct: 1, why: "The two alleles of a gene separate when gametes form, so each gamete carries only one allele per gene." }
    ]
  }
  ]
},

generic: {
  subject: "General Studies",
  topics: [
  {
    title: "Overview and Key Concepts",
    short: "This section establishes the foundation of the document: what its subject is, why it matters, and the core ideas the author wants you to carry into every later section.",
    keyPoints: [
      "Identify the central theme — the single idea the whole document keeps returning to.",
      "Note how the author defines the subject in the opening section.",
      "Distinguish the document's main claims from supporting details.",
      "Connect this overview to your own course objectives or exam coverage."
    ],
    terms: [
      { t: "Central theme", d: "The main idea that unifies all sections of the document." },
      { t: "Key concept", d: "An important idea the reader must understand to grasp the subject." },
      { t: "Supporting detail", d: "Evidence or examples that back up a main claim." },
      { t: "Scope", d: "The boundaries of what the document covers — and what it deliberately leaves out." }
    ],
    deepDive: [
      { h: "How to read an overview well", p: [
        "Start by asking what problem the document exists to solve. Every well-written module or reviewer opens by establishing a gap — something the reader does not yet know or cannot yet do — and promising to close it.",
        "As you read, mark statements the author clearly considers important: definitions set apart from the text, repeated phrasings, and summaries at section ends."
      ] },
      { h: "Building a concept map from the overview", p: [
        "Write the central theme in the middle of a page. Around it, place the key concepts named in the overview, then connect each one to the section where it is explained in depth.",
        "This two-minute habit converts a passive first read into an active survey — and gives you a revision sheet for free."
      ], why: "Examiners reward students who state the main idea in their own words. Paraphrasing the overview from memory is the fastest self-test you can run." },
      { h: "Common reading mistakes", p: [
        "The most common mistake is treating every sentence as equally important. Rank the material: definitions and frameworks are load-bearing; anecdotes and asides usually are not.",
        "The second mistake is reading without a purpose. Before opening the document, write one question you want it to answer — you will retain dramatically more."
      ], check: { q: "Why is it useful to state the central theme in your own words after reading?", a: "Paraphrasing forces active processing and reveals whether you truly understood — it doubles as an instant self-test." } }
    ],
    questions: [
      { q: "What is the best first step when studying a new document?", opts: ["Memorize every sentence", "Identify the central theme and what the document promises to teach", "Skip to the last page", "Copy the text word for word"], correct: 1, why: "Finding the central theme first gives every later section a place to attach in your memory." },
      { q: "Supporting details primarily serve to...", opts: ["Replace the main claims", "Back up and illustrate the main claims", "Fill space in the document", "Confuse the reader"], correct: 1, why: "Details are evidence — they exist to make the main claims believable and memorable." }
    ]
  },
  {
    title: "Core Principles",
    short: "Core principles are the working rules of the subject — the statements that explain why things happen the way they do. Understanding principles lets you predict outcomes, not just recall facts.",
    keyPoints: [
      "A principle explains cause and effect, not just description.",
      "Principles often appear as 'if–then' statements in the source text.",
      "Each principle is usually followed by an example — study them together.",
      "Being able to restate a principle and give an example is exam-ready mastery."
    ],
    terms: [
      { t: "Principle", d: "A fundamental rule or law that explains how something works." },
      { t: "Cause and effect", d: "The relationship where one event produces another." },
      { t: "Application", d: "Using a principle in a concrete situation." },
      { t: "Exception", d: "A case where a principle does not apply as stated." }
    ],
    deepDive: [
      { h: "From facts to principles", p: [
        "Facts tell you what happened; principles tell you why. A student who memorizes only facts can answer only the questions they have seen before — a student who knows the principles can answer questions they have never seen.",
        "Hunt for principle statements in your document: they are often bolded, numbered, or introduced with phrases like 'the reason is' or 'as a result.'"
      ] },
      { h: "The example is part of the principle", p: [
        "Authors include examples for a reason: an abstract rule becomes concrete only through a case. When you study a principle, always pair it with the author's example and then invent one of your own.",
        "Creating your own example is the single most reliable test of whether you understand the principle or have merely memorized its words."
      ] },
      { h: "Handling exceptions", p: [
        "Real subjects are messy: most principles have boundary conditions. When the document mentions an exception or limitation, flag it — examiners use exceptions to separate surface learners from deep learners.",
        "A useful habit: for each principle, write one sentence on where it applies and one on where it breaks down."
      ], check: { q: "Why is inventing your own example more effective than rereading the author's?", a: "Creating a new example forces retrieval and application, which builds much stronger memory than passive rereading." } }
    ],
    questions: [
      { q: "What distinguishes a principle from a plain fact?", opts: ["Principles are longer", "Principles explain cause and effect", "Facts are always wrong", "Principles need no examples"], correct: 1, why: "A principle explains WHY something happens, letting you predict new cases; a fact only records WHAT happened." },
      { q: "What should you do when a document states an exception to a principle?", opts: ["Ignore it", "Memorize it — exceptions are common exam targets", "Assume the principle is wrong", "Skip the whole section"], correct: 1, why: "Exceptions mark the boundaries of a principle's validity, and examiners frequently probe exactly those boundaries." }
    ]
  },
  {
    title: "Important Processes",
    short: "Processes are the step-by-step procedures the document describes. Mastering a process means knowing the steps in order, what each step accomplishes, and where the process can fail or change.",
    keyPoints: [
      "Learn processes as ordered sequences — each step enables the next.",
      "For every step, know its input, its action, and its output.",
      "Watch for decision points where the process branches.",
      "Practicing the sequence from memory is the only real test of mastery."
    ],
    terms: [
      { t: "Process", d: "An ordered series of actions that accomplishes a task." },
      { t: "Sequence", d: "The required order of steps in a process." },
      { t: "Decision point", d: "A step where the process branches based on a condition." },
      { t: "Output", d: "The result produced by a step or the whole process." }
    ],
    deepDive: [
      { h: "Reading a process as a chain", p: [
        "Every step in a well-designed process exists because the previous step produced something it needs. When you understand each link — what it receives, what it does, what it hands forward — the whole sequence becomes hard to forget.",
        "Diagram the chain on paper: one box per step, arrows showing what flows between them. Blank-page recall of this diagram is a powerful revision drill."
      ] },
      { h: "Decision points and branches", p: [
        "Most real processes are not straight lines. At decision points, a condition is checked and the flow splits — handling the error case, the special case, or the alternative path.",
        "Exam questions on processes almost always test the branches: 'What happens if step 3 finds no records?' Trace the branch as carefully as the happy path."
      ] },
      { h: "Where processes fail", p: [
        "Ask of each step: what could go wrong here, and what does the document say to do about it? Failure modes reveal the process's hidden assumptions.",
        "This critical reading pays off doubly: it prepares you for tricky exam items AND builds real-world judgment in the subject."
      ], check: { q: "Why is it important to learn a process in order rather than as a loose set of steps?", a: "Each step depends on the previous one's output — knowing the order reveals the logic that holds the process together." } }
    ],
    questions: [
      { q: "A decision point in a process is where...", opts: ["The process always ends", "The flow branches based on a condition", "A step is skipped randomly", "The output is produced"], correct: 1, why: "At a decision point a condition is checked and the process follows one of two or more branches." },
      { q: "The most reliable way to check you have mastered a process is to...", opts: ["Reread it three times", "Recite the steps in order from memory", "Highlight every step", "Copy the diagram"], correct: 1, why: "Retrieval from memory (active recall) is far stronger evidence of mastery than rereading (passive review)." }
    ]
  },
  {
    title: "Key Terms and Definitions",
    short: "Every subject builds its own vocabulary, and exams test it directly. A term is mastered when you can define it precisely, recognize it in context, and use it in a sentence of your own.",
    keyPoints: [
      "Learn definitions verbatim first, then paraphrase.",
      "Attach one concrete example to each term.",
      "Group related terms so they reinforce each other.",
      "Test both directions: given the term, produce the definition — and vice versa."
    ],
    terms: [
      { t: "Definition", d: "A precise statement of what a term means." },
      { t: "Context", d: "The surrounding text that shows how a term is actually used." },
      { t: "Distinction", d: "The difference between two easily confused terms." },
      { t: "Usage", d: "The way a term is correctly applied in sentences." }
    ],
    deepDive: [
      { h: "The two-pass method for vocabulary", p: [
        "First pass: read the definition exactly as written and memorize its shape. Second pass: close the document and restate the definition in your own words, then compare — the differences show you what you missed.",
        "Terms you cannot paraphrase are terms you do not yet own, no matter how many times you have reread them."
      ] },
      { h: "Terms travel in families", p: [
        "Isolated flashcards work, but grouped terms work harder. Learn each term alongside its neighbors — the ones it is contrasted with, the ones it builds upon, the ones that share its prefix or root.",
        "For every pair of look-alike terms, write one line on how they differ. Those distinction lines are gold on multiple-choice exams."
      ], example: "Self-test template for any term: (1) define it in one sentence, (2) give one example, (3) state how it differs from its closest relative term." },
      { h: "Testing in both directions", p: [
        "Recognition (seeing the definition and picking the term) is easy; recall (seeing the term and producing the definition) is hard. Exams test both, so practice both.",
        "Flashcards naturally train term-to-definition; cover the term side and read the definition aloud to train the reverse."
      ], check: { q: "Why practice producing the definition from the term, not just recognizing the term from the definition?", a: "Recall is the harder skill and the one most exams actually measure — recognition alone creates an illusion of knowing." } }
    ],
    questions: [
      { q: "What does the 'two-pass method' recommend?", opts: ["Reading twice quickly", "Memorize verbatim, then restate in your own words and compare", "Skipping hard terms", "Copying definitions five times"], correct: 1, why: "Verbatim memorizing secures precision; paraphrasing and comparing reveals gaps in true understanding." },
      { q: "Why should similar terms be studied together?", opts: ["To save paper", "Contrasting them cements the distinctions exams probe", "They always mean the same thing", "It makes reading faster"], correct: 1, why: "Look-alike terms are classic exam distractors; studying them as a family sharpens exactly the differences being tested." }
    ]
  },
  {
    title: "Applications and Examples",
    short: "Applications show the subject at work in real situations. Examples are not decoration — they are where abstract rules become visible, and where exam questions typically live.",
    keyPoints: [
      "Every major rule in the document should be paired with its example.",
      "Worked examples model the reasoning steps you must reproduce.",
      "Inventing your own example is the strongest comprehension test.",
      "Case scenarios in exams usually restate an example with changed details."
    ],
    terms: [
      { t: "Worked example", d: "A problem solved step by step, showing the reasoning explicitly." },
      { t: "Case scenario", d: "An exam-style situation requiring you to apply rules to new details." },
      { t: "Transfer", d: "Applying what you learned to a situation different from the one taught." },
      { t: "Analysis", d: "Breaking a situation into parts to see which rules apply." }
    ],
    deepDive: [
      { h: "Studying worked examples actively", p: [
        "Do not just read a worked example — hide the solution, attempt it yourself, then compare step by step. The gap between your attempt and the author's solution is a personalized list of what to review.",
        "Cover-and-attempt turns a passive page into active practice, and it takes barely longer than reading."
      ] },
      { h: "How exam scenarios are built", p: [
        "Test writers almost never invent scenarios from nothing: they take the document's example, change names, numbers, or context, and ask you to apply the same rule. That means the worked examples in your material are the closest thing to a leaked exam.",
        "For each worked example, ask: what if this number were bigger? What if this condition were false? Replaying examples with variations builds the flexibility scenarios demand."
      ] },
      { h: "From example to your own", p: [
        "The final level of mastery is generating an original example. It proves you have separated the rule from its packaging and can carry it into any context.",
        "If you can teach the rule to a classmate using your own example, the rule is yours permanently."
      ], check: { q: "What is the best way to study a worked example?", a: "Attempt it yourself before looking, then compare your steps against the solution to find gaps." } }
    ],
    questions: [
      { q: "Exam scenario questions usually...", opts: ["Are unrelated to the document", "Restate the document's examples with changed details", "Require no rules", "Can only be guessed"], correct: 1, why: "Test writers typically adapt the source's own examples — making them the highest-value study material." },
      { q: "Creating your own example of a rule demonstrates...", opts: ["Nothing useful", "That you can transfer the rule beyond its original context", "That you memorized the text", "That the rule is easy"], correct: 1, why: "Generating an original example is evidence of true understanding — you have detached the rule from its packaging." }
    ]
  },
  {
    title: "Review and Synthesis",
    short: "Synthesis is connecting all the document's pieces into one coherent picture: how the principles, processes, terms, and examples relate to each other and to the central theme.",
    keyPoints: [
      "Synthesis means seeing relationships, not just listing topics.",
      "A one-page summary in your own words is the ideal final product.",
      "Self-testing beats rereading for long-term retention.",
      "Schedule spaced reviews — 1 day, 1 week, 1 month later."
    ],
    terms: [
      { t: "Synthesis", d: "Combining parts into a coherent whole by mapping their relationships." },
      { t: "Summary", d: "A condensed restatement of the main ideas in your own words." },
      { t: "Spaced repetition", d: "Reviewing material at increasing intervals to fight forgetting." },
      { t: "Active recall", d: "Retrieving information from memory as a study technique." }
    ],
    deepDive: [
      { h: "The synthesis map", p: [
        "On one page, place the central theme at the center and draw connections to every major section: which principle supports which process, which terms belong to which example, which overview claim each section proves.",
        "This map is your complete mental model of the document — and it fits on a single sheet you can review in minutes before the exam."
      ] },
      { h: "The testing effect", p: [
        "Decades of research converge on one finding: retrieving information from memory strengthens it far more than rereading it. Every quiz you take here is not just assessment — it IS the studying.",
        "This is why Knozen AI generates practice quizzes from your own document: the questions force the retrievals that lock the material in."
      ] },
      { h: "Spacing your reviews", p: [
        "Memory decays on a predictable curve, and each review flattens the curve further. A practical schedule: review your synthesis one day after first study, one week later, and one month later.",
        "Three spaced passes beat five crammed passes — with less total time invested."
      ], check: { q: "Why is self-testing more effective than rereading?", a: "Retrieval from memory (active recall) strengthens the memory trace much more than passive exposure does." } }
    ],
    questions: [
      { q: "Synthesis differs from summary in that synthesis...", opts: ["Is longer", "Maps how ideas relate to each other and the central theme", "Copies the text", "Requires no understanding"], correct: 1, why: "A summary condenses; a synthesis connects — it shows the relationship web holding the document together." },
      { q: "A good spaced-review schedule after first studying is...", opts: ["Review only the night before the exam", "Review after 1 day, 1 week, and 1 month", "Review ten times in one day", "Never review again"], correct: 1, why: "Increasing intervals (spaced repetition) flatten the forgetting curve efficiently; cramming produces fast decay." }
    ]
  }
  ]
}
};

/* ============================================================
   GENERATOR — builds structured study material for a document.
   Interface (kept LLM-ready): Generator.build({fileName, pages})
   -> { subject, topics: [{title, page, excerpt, short, keyPoints,
        terms, deepDive, questions}] }
   ============================================================ */
const Generator = {
  PACK_KEYS: Object.keys(PACKS),

  detectPack(fileName) {
    const f = fileName.toLowerCase();
    if (/program|code|python|java|script|css|html|software|comput|it module|web dev/.test(f)) return "programming";
    if (/history|rizal|philippine|kolonyal|revolution|kasaysayan/.test(f)) return "history";
    if (/bio|cell|genetic|photosynth|anatomy|science|dna/.test(f)) return "biology";
    return "generic";
  },

  // pages: [{page, text}] | null (extraction unavailable)
  build(fileName, pages) {
    const packKey = this.detectPack(fileName);
    const pack = PACKS[packKey];
    const N = pack.topics.length;
    const chunks = [];
    if (pages && pages.length) {
      const per = Math.max(1, Math.ceil(pages.length / N));
      for (let i = 0; i < N; i++) {
        const slice = pages.slice(i * per, (i + 1) * per);
        if (!slice.length) break;
        const text = slice.map(p => p.text).join(" ");
        chunks.push({ page: slice[0].page, excerpt: text.slice(0, 320) });
      }
    }
    const topics = pack.topics.map((t, i) => {
      const c = chunks[i] || null;
      return {
        id: "t" + i,
        title: t.title,
        page: c ? c.page : null,
        excerpt: c ? c.excerpt : null,
        short: t.short, keyPoints: t.keyPoints, terms: t.terms,
        deepDive: t.deepDive, questions: t.questions,
        studied: false
      };
    });
    return { packKey, subject: pack.subject, topics };
  }
};

/* ---------------- PDF text extraction (pdf.js, with offline fallback) ------- */
async function extractPdfPages(file) {
  if (typeof pdfjsLib === "undefined") return null;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    const limit = Math.min(pdf.numPages, 80);
    for (let i = 1; i <= limit; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
      if (text) pages.push({ page: i, text });
    }
    return pages.length ? pages : null;
  } catch (e) {
    console.warn("PDF extraction failed, using template fallback:", e);
    return null;
  }
}

/* ============================================================
   ROUTER
   ============================================================ */
const Router = {
  parse() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    return { parts };
  },
  go(path) { location.hash = "#" + path; },
  render() {
    const { parts } = this.parse();
    const user = Auth.current();
    const pub = parts[0] === "auth" || parts[0] === "register" || parts.length === 0 && !user;

    // Auth guard: protected routes need a session
    if (!user && parts[0] !== "auth" && parts[0] !== "register") {
      return this.go("/auth");
    }
    if (user && (parts[0] === "auth" || parts[0] === "register" || parts.length === 0)) {
      return this.go("/home");
    }

    $("#topbar").classList.toggle("hidden", !user);
    $("#bottomnav").classList.toggle("hidden", !user);
    if (user) {
      const t = Auth.current().tokens;
      const chip = $("#token-chip");
      const cu = Auth.current();
      const isPro = Plans.isPro(cu), isPaid = Plans.isPaid(cu);
      chip.textContent = isPro ? "Pro \u00B7 Unlimited" : (isPaid ? "Plus \u00B7 " : "") + t + " Tokens";
      chip.classList.toggle("low", !isPro && t < 30);
      chip.classList.toggle("pro", isPaid);
      chip.title = "View plans";
      chip.onclick = () => Router.go("/plans");
    }

    const app = $("#app");
    window.scrollTo(0, 0);

    if (!user) {
      return parts[0] === "register" ? Views.register(app, parts[1]) : Views.signin(app, parts[1]);
    }

    const route = parts[0] || "home";
    if (route === "home")        return Views.home(app);
    if (route === "upload")      return Views.upload(app);
    if (route === "library")     return Views.library(app);
    if (route === "study")       return Views.study(app, parts[1], parseInt(parts[2] || "0", 10), parts[3] || "learn");
    if (route === "profile")     return Views.profile(app);
    if (route === "plans")       return Views.plans(app);
    return Views.home(app);
  },
  setActive(name) {
    $$("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === name));
  }
};

/* ============================================================
   VIEWS
   ============================================================ */
/* ---------------- Login roles ---------------- */
const ROLES = {
  student: { label: "Student", hint: "Study from your PDFs with quizzes and guides", sub: "Sign in to your study library.",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9l10-5 10 5-10 5-10-5Z"/><path d="M6 11.5V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.5"/></svg>` },
  teacher: { label: "Teacher", hint: "Sign in to your teacher account", sub: "Sign in to your teacher account.",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8M7 9h6M7 12h4"/></svg>` }
};
const AUTH_BRAND = `<a class="brand" href="#/auth"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M8.5 11.5c4.8-.9 8.5-.1 11.5 2.5v16c-3-2.5-6.7-3.4-11.5-2.5v-16Z" fill="currentColor" fill-opacity=".96"/><path d="M31.5 11.5c-4.8-.9-8.5-.1-11.5 2.5v16c3-2.5 6.7-3.4 11.5-2.5v-16Z" fill="currentColor" fill-opacity=".72"/><path d="M20 14v16" stroke="#24675F" stroke-width="1.4"/><path d="M29 7V3.5M32.5 10.5H36M31.5 8l2.4-2.4" stroke="#F6C66A" stroke-width="1.8" stroke-linecap="round"/></svg></span><span class="brand-name">Knozen AI</span></a>`;

const Views = {

  /* ---------- Sign in: role picker, then one form per role ---------- */
  roleSelect(el) {
    el.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      ${AUTH_BRAND}
      <h1>Welcome back</h1>
      <p class="sub">Choose how you want to log in.</p>
      <div class="role-list">
        ${Object.keys(ROLES).map(k => `
        <a class="role-opt" href="#/auth/${k}">
          <span class="role-ico" aria-hidden="true">${ROLES[k].icon}</span>
          <span class="role-txt"><b>Login as ${ROLES[k].label}</b><span>${ROLES[k].hint}</span></span>
        </a>`).join("")}
      </div>
      <div class="auth-foot">New to Knozen AI? <a href="#/register/student">Sign up as a student</a> or <a href="#/register/teacher">as a teacher</a></div>
    </div></div>`;
  },

  signin(el, role) {
    if (!ROLES[role]) return this.roleSelect(el);
    const R = ROLES[role];
    el.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      <a class="role-back" href="#/auth">Back to login options</a>
      ${AUTH_BRAND}
      <h1>${R.label} login</h1>
      <p class="sub">${R.sub}</p>
      <div class="form-alert" id="auth-alert" role="alert"></div>
      <form id="login-form" novalidate>
        <div class="field" id="f-email">
          <label for="li-email">Email</label>
          <input id="li-email" type="email" autocomplete="email" placeholder="you@school.edu">
          <div class="err">Enter a valid email address.</div>
        </div>
        <div class="field" id="f-pass">
          <label for="li-pass">Password</label>
          <input id="li-pass" type="password" autocomplete="current-password" placeholder="Your password">
          <div class="err">Password is required.</div>
        </div>
        <div class="check-row">
          <input type="checkbox" id="li-remember" checked>
          <label for="li-remember" style="font-weight:400;margin:0">Remember me on this device</label>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Sign In</button>
      </form>
      <div class="auth-foot">New to Knozen AI? <a href="#/register/${role}">Create a ${R.label.toLowerCase()} account</a></div>
    </div></div>`;
    $("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const al = $("#auth-alert"); al.textContent = ""; al.classList.remove("show");
      const email = $("#li-email").value, pass = $("#li-pass").value;
      let ok = true;
      ok = App.validate("f-email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) && ok;
      ok = App.validate("f-pass", pass.length > 0) && ok;
      if (!ok) return;
      const r = Auth.login(email, pass, $("#li-remember").checked, role);
      if (!r.ok) {
        App.authError(r.error);
        if (r.switchTo) al.insertAdjacentHTML("beforeend", ` <a href="#/auth/${r.switchTo}">Go to ${ROLES[r.switchTo].label} login</a>`);
        return;
      }
      toast("Signed in. Welcome back, " + r.user.name.split(" ")[0] + ".");
      Router.go("/home");
    });
  },

  /* ---------- Register ---------- */
  register(el, role) {
    if (!ROLES[role]) role = "student";
    const R = ROLES[role];
    el.innerHTML = `
    <div class="auth-shell"><div class="auth-card">
      ${AUTH_BRAND}
      <h1>Create your ${R.label.toLowerCase()} account</h1>
      <p class="sub">Start turning your PDFs into study material. You get <b>120 free tokens</b>.</p>
      <div class="form-alert" id="auth-alert" role="alert"></div>
      <form id="reg-form" novalidate>
        <div class="field" id="f-name">
          <label for="rg-name">Full name</label>
          <input id="rg-name" type="text" autocomplete="name" placeholder="Juan Dela Cruz">
          <div class="err">Please enter your full name.</div>
        </div>
        <div class="field" id="f-email">
          <label for="rg-email">Email</label>
          <input id="rg-email" type="email" autocomplete="email" placeholder="you@school.edu">
          <div class="err">Enter a valid email address.</div>
        </div>
        <div class="field" id="f-pass">
          <label for="rg-pass">Password</label>
          <input id="rg-pass" type="password" autocomplete="new-password" placeholder="At least 8 characters">
          <div class="err">Password must be at least 8 characters.</div>
        </div>
        <div class="field" id="f-pass2">
          <label for="rg-pass2">Confirm password</label>
          <input id="rg-pass2" type="password" autocomplete="new-password" placeholder="Repeat your password">
          <div class="err">Passwords do not match.</div>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Create Account</button>
      </form>
      <div class="auth-foot">Already have an account? <a href="#/auth/${role}">Sign in</a></div>
    </div></div>`;
    $("#reg-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#rg-name").value, email = $("#rg-email").value;
      const p1 = $("#rg-pass").value, p2 = $("#rg-pass2").value;
      let ok = true;
      ok = App.validate("f-name", name.trim().length >= 2) && ok;
      ok = App.validate("f-email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) && ok;
      ok = App.validate("f-pass", p1.length >= 8) && ok;
      ok = App.validate("f-pass2", p2 === p1 && p1.length > 0) && ok;
      if (!ok) return;
      const r = Auth.register(name, email, p1, role);
      if (!r.ok) return App.authError(r.error);
      toast("Account created — 120 tokens added.");
      Router.go("/home");
    });
  },

  /* ---------- Home ---------- */
  home(el) {
    Router.setActive("home");
    const user = Auth.current();
    const docs = Docs.all();
    const attempts = Attempts.all();
    const studied = docs.reduce((n, d) => n + d.topics.filter(t => t.studied).length, 0);
    const avg = attempts.length
      ? Math.round(attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length * 100) : null;

    el.innerHTML = `
    <section class="hero"><div class="wrap">
      <div class="hero-big">
        <div class="hero-kicker">Knozen AI — study smarter</div>
        <h1 class="mega"><span>Read.</span><span class="hl">Learn.</span><span>Master.</span></h1>
        <div class="hero-foot">
          <p>Turn class PDFs into clear topic guides, focused explanations, and practice quizzes — all in one personal study space.</p>
          <div class="hero-actions">
            <a class="btn btn-primary btn-lg" href="#/upload">Upload a PDF &rarr;</a>
            <a class="btn btn-outline btn-lg" href="#/library">Your library</a>
          </div>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><div class="n">${docs.length}</div><div class="l">PDFs in your library</div></div>
        <div class="hero-stat"><div class="n">${studied}</div><div class="l">Topics studied</div></div>
        <div class="hero-stat"><div class="n">${attempts.length}</div><div class="l">Quizzes taken</div></div>
        <div class="hero-stat"><div class="n">${avg == null ? "—" : avg + "%"}</div><div class="l">Average quiz score</div></div>
      </div>
    </div></section>

    <section class="steps"><div class="wrap">
      <h2>How Knozen AI works</h2>
      <div class="step-grid">
        <div class="step">
          <div class="num">01 — Upload</div>
          <h3>Upload a PDF</h3>
          <p>Drop in a module, reviewer, textbook chapter, lecture handout, or any study material you're actually assigned.</p>
        </div>
        <div class="step">
          <div class="num">02 — Understand</div>
          <h3>Knozen AI organizes it</h3>
          <p>Your document is divided into topics with short explanations, key points, important terms, and detailed deep dives — sourced from your pages.</p>
        </div>
        <div class="step">
          <div class="num">03 — Practice</div>
          <h3>Test yourself</h3>
          <p>Generate a practice quiz from the document's topics, see explanations for every answer, and watch your progress grow.</p>
        </div>
      </div>
    </div></section>

    <section class="home-section"><div class="wrap">
      <h2>The kind of material students upload</h2>
      <div class="doc-list">
        ${[
          ["Computer Programming Module 4", "Programming Fundamentals", "12 topics"],
          ["Philippine History Reviewer", "History", "10 topics"],
          ["Computer Systems Servicing Module", "IT & Systems", "9 topics"],
          ["Biology Lecture Notes — Cell Biology", "Biology", "11 topics"],
          ["Board Exam Review Material", "Professional Review", "14 topics"]
        ].map(d => `
          <a class="doc-row" href="#/upload">
            <span class="doc-thumb">PDF</span>
            <span class="doc-row-main">
              <span class="doc-row-title">${d[0]}</span>
              <span class="doc-row-meta" style="display:block">${d[1]} &middot; becomes ${d[2]}</span>
            </span>
            <span class="arrow">&rarr;</span>
          </a>`).join("")}
      </div>
    </div></section>

    <section class="home-cta"><div class="wrap">
      <a class="btn btn-primary btn-lg" href="#/upload">Upload Your First PDF</a>
    </div></section>`;
  },

  /* ---------- Upload ---------- */
  upload(el) {
    Router.setActive("upload");
    const user = Auth.current();
    const COST = App.PROCESS_COST;
    el.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <h1>Upload a study document</h1>
        <p class="lede">Add a PDF to your personal study library. ${Plans.isPro(user) ? "Processing is <b>included</b> with Pro" : "Processing costs <b>" + COST + " tokens</b>"} and turns the document into topics, explanations, and quizzes.</p>
      </div>
      <div class="upload-grid">
        <div>
          <div class="dropzone" id="dropzone">
            <div class="dz-ico">&#8679;</div>
            <h3>Drag &amp; drop your PDF here</h3>
            <p>or click to browse your files</p>
            <div class="dz-formats">PDF only &middot; max 25 MB</div>
          </div>
          <input type="file" id="file-input" accept="application/pdf,.pdf" hidden>
          <div class="file-card" id="file-card"></div>
        </div>
        <div>
          <div class="upload-note">
            <h4>What happens after you upload</h4>
            <ul>
              <li>The PDF text is extracted page by page.</li>
              <li>The document is divided into topics or sections.</li>
              <li>Each topic gets a short explanation, key points, terms, and a deep dive.</li>
              <li>A practice quiz and flashcards are generated from the material.</li>
              <li>The document appears in your Study Library, private to your account.</li>
            </ul>
            <div class="token-box">
              <span>Your token balance</span>
              <b id="up-tokens">${user.tokens}</b>
            </div>
          </div>
        </div>
      </div>
    </div>`;

    const dz = $("#dropzone"), fi = $("#file-input");
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", e => {
      e.preventDefault(); dz.classList.remove("dragover");
      if (e.dataTransfer.files.length) App.selectFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener("change", () => { if (fi.files.length) App.selectFile(fi.files[0]); });
  },

  /* ---------- Library ---------- */
  library(el) {
    Router.setActive("library");
    const docs = Docs.all();
    const subjects = [...new Set(docs.map(d => d.subject))];

    el.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <h1>Study Library</h1>
        <p class="lede">Your personal collection of study documents. Pick up where you left off.</p>
      </div>
      <div class="lib-toolbar" id="lib-toolbar" ${docs.length ? "" : 'style="display:none"'}>
        <div class="search-box"><input id="lib-search" type="text" placeholder="Search your PDFs..." oninput="App.libFilter()"></div>
        <select class="select-plain" id="lib-subject" onchange="App.libFilter()">
          <option value="">All subjects</option>
          ${subjects.map(s => `<option>${esc(s)}</option>`).join("")}
        </select>
        <select class="select-plain" id="lib-sort" onchange="App.libFilter()">
          <option value="recent">Recently uploaded</option>
          <option value="studied">Recently studied</option>
          <option value="title">Title A–Z</option>
          <option value="progress">Most progress</option>
        </select>
      </div>
      <div id="lib-body"></div>
    </div>`;
    App.renderLibGrid();
  },

  /* ---------- Study (per document) ---------- */
  study(el, docId, tIdx, tab) {
    const doc = Docs.get(docId);
    if (!doc) {
      el.innerHTML = `
      <div class="wrap"><div class="empty-state" style="margin-top:50px">
        <div class="es-ico">?</div>
        <h3>This PDF is not available</h3>
        <p>The document may have been deleted or the link is incorrect.</p>
        <a class="btn btn-primary" href="#/library">Back to Library</a>
      </div></div>`;
      return;
    }
    tIdx = Math.max(0, Math.min(tIdx || 0, doc.topics.length - 1));
    const studied = doc.topics.filter(t => t.studied).length;
    const pct = Math.round(studied / doc.topics.length * 100);
    const attempts = Attempts.forDoc(doc.id);
    const avg = attempts.length
      ? Math.round(attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length * 100) : null;

    el.innerHTML = `
    <div class="wrap">
      <div class="page-head" style="border-bottom:none;padding-bottom:0">
        <div class="crumb"><a href="#/library">Library</a> &nbsp;/&nbsp; ${esc(doc.name)}</div>
        <h1>${esc(doc.name)}</h1>
        <p class="lede">${esc(doc.subject)} &middot; uploaded ${fmtDate(doc.uploadedAt)}</p>
      </div>
      <div class="study-strip">
        <div class="ss-item"><div class="n">${doc.topics.length}</div><div class="l">Topics</div></div>
        <div class="ss-item"><div class="n">${studied}/${doc.topics.length}</div><div class="l">Studied</div></div>
        <div class="ss-item"><div class="n">${pct}%</div><div class="l">Progress</div></div>
        <div class="ss-item"><div class="n">${attempts.length}</div><div class="l">Quiz attempts</div></div>
        <div class="ss-item"><div class="n">${avg == null ? "—" : avg + "%"}</div><div class="l">Avg quiz score</div></div>
        <div class="ss-item"><div class="n">${doc.lastStudied ? fmtDate(doc.lastStudied) : "—"}</div><div class="l">Last studied</div></div>
      </div>
      <div class="study-layout">
        <aside class="topic-nav">
          <h4>Topics in this document</h4>
          <div class="tnav-list">
            ${doc.topics.map((t, i) => `
              <a class="tnav-item ${i === tIdx ? "active" : ""} ${t.studied ? "done" : ""}"
                 href="#/study/${doc.id}/${i}/${tab}">
                <span class="tnav-num">${String(i + 1).padStart(2, "0")}</span>
                <span class="tnav-title">${esc(t.title)}</span>
                <span class="tnav-check">&#10003;</span>
              </a>`).join("")}
          </div>
        </aside>
        <section id="study-main">
          <div class="study-tabs">
            <button class="${tab === "learn" ? "active" : ""}" onclick="App.goStudy('${doc.id}',${tIdx},'learn')">Study</button>
            <button class="${tab === "flashcards" ? "active" : ""}" onclick="App.goStudy('${doc.id}',${tIdx},'flashcards')">Flashcards</button>
            <button class="${tab === "quiz" ? "active" : ""}" onclick="App.goStudy('${doc.id}',${tIdx},'quiz')">Practice Quiz</button>
          </div>
          <div id="tab-body"></div>
        </section>
      </div>
    </div>`;

    if (tab === "quiz") App.renderQuizTab(doc);
    else if (tab === "flashcards") App.renderFlashcards(doc, tIdx);
    else App.renderLearn(doc, tIdx);
  },

  /* ---------- Profile ---------- */
  profile(el) {
    Router.setActive("profile");
    const user = Auth.current();
    const docs = Docs.all();
    const attempts = Attempts.all();
    const sessions = Sessions.all();
    const topicsStudied = docs.reduce((n, d) => n + d.topics.filter(t => t.studied).length, 0);
    const avgPct = attempts.length
      ? Math.round(attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length * 100) : 0;

    const credit = App.creditScore(topicsStudied, attempts.length, avgPct);
    const creditPct = Math.round((credit - 300) / 550 * 100);

    el.innerHTML = `
    <div class="wrap">
      <div class="page-head">
        <h1>Profile</h1>
        <p class="lede">Your account, tokens, and study activity.</p>
      </div>
      <div class="profile-grid">
        <div style="display:flex;flex-direction:column;gap:22px">
          <div class="panel">
            <div class="panel-head"><h3>Account</h3></div>
            <div class="panel-body">
              <div class="avatar">${esc(user.name.trim()[0].toUpperCase())}</div>
              <div class="p-row"><span class="k">Name</span><span class="v">${esc(user.name)}</span></div>
              <div class="p-row"><span class="k">Email</span><span class="v">${esc(user.email)}</span></div>
              <div class="p-row"><span class="k">Member since</span><span class="v">${fmtDate(user.createdAt)}</span></div>
              <div class="p-row"><span class="k">Current plan</span><span class="v"><span class="plan-badge ${Plans.isPaid(user) ? "pro" : ""}">${esc(Plans.tier(user))}</span> <a class="plan-link" href="#/plans">${Plans.isPaid(user) ? "Manage" : "Upgrade"}</a></span></div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head"><h3>Study Tokens</h3></div>
            <div class="panel-body">
              <div class="tokens-big">${Plans.isPro(user) ? "Unlimited" : user.tokens}</div>
              <div class="tokens-lbl">${Plans.isPro(user) ? "processing included with Pro" : "tokens remaining"}</div>
              ${!Plans.isPro(user) && user.tokens < 30 ? `<p style="font-size:13px;color:var(--bad);margin-top:12px">Low balance — processing a PDF costs ${App.PROCESS_COST} tokens. <a class="plan-link" style="margin-left:0" href="#/plans">Get more tokens</a></p>` : ""}
              <ul class="token-uses">
                <li>PDF processing — ${App.PROCESS_COST} tokens</li>
                <li>Study guide generation — ${App.PROCESS_COST} tokens</li>
                <li>Deep Dive generation — included</li>
                <li>Quiz generation — included</li>
              </ul>
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:22px">
          <div class="panel">
            <div class="panel-head"><h3>Credit Score</h3></div>
            <div class="panel-body">
              <div class="credit-wrap">
                <div class="credit-num">${credit}</div>
                <div class="credit-scale">
                  <div class="credit-bar"><div class="credit-fill" style="width:${creditPct}%"></div></div>
                  <div class="credit-range"><span>300</span><span>Excellent: 750+</span><span>850</span></div>
                </div>
              </div>
              <p class="credit-note">Your Knozen AI Credit Score reflects your learning consistency — topics studied, quiz attempts, and average scores. It grows as you study regularly. ${credit >= 750 ? "Excellent standing — keep it up." : credit >= 620 ? "Good standing. More quiz attempts will push it higher." : "Just getting started — study topics and take quizzes to build it."}</p>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head"><h3>Study Activity</h3></div>
            <div class="panel-body" style="padding:0">
              <div class="stat-grid">
                <div class="stat-cell"><div class="n">${docs.length}</div><div class="l">PDFs processed</div></div>
                <div class="stat-cell"><div class="n">${topicsStudied}</div><div class="l">Topics studied</div></div>
                <div class="stat-cell"><div class="n">${attempts.length}</div><div class="l">Quiz attempts</div></div>
                <div class="stat-cell"><div class="n">${attempts.length ? avgPct + "%" : "—"}</div><div class="l">Average quiz score</div></div>
                <div class="stat-cell"><div class="n">${sessions.length}</div><div class="l">Study sessions</div></div>
                <div class="stat-cell"><div class="n">${docs.filter(d => d.lastStudied).length}</div><div class="l">Documents opened</div></div>
              </div>
            </div>
          </div>
          ${attempts.length ? `
          <div class="panel">
            <div class="panel-head"><h3>Recent Quiz Attempts</h3></div>
            <div class="panel-body quiz-history">
              <table>
                <tr><th>Document</th><th>Score</th><th>Date</th></tr>
                ${attempts.slice(0, 6).map(a => {
                  const d = Docs.get(a.docId);
                  const pct = Math.round(a.score / a.total * 100);
                  return `<tr>
                    <td>${esc(d ? d.name : "Deleted document")}</td>
                    <td><span class="score-pill ${pct >= 75 ? "" : pct >= 50 ? "mid" : "low"}">${a.score}/${a.total}</span></td>
                    <td>${fmtDate(a.at)}</td></tr>`;
                }).join("")}
              </table>
            </div>
          </div>` : ""}
        </div>
      </div>
    </div>`;
  }
};

/* ============================================================
   APP — global actions (exposed for inline handlers)
   ============================================================ */
const App = {
  PROCESS_COST: 10,
  _quiz: null,       // active quiz session
  _fc: null,         // flashcard state
  _up: { file: null, status: "idle", timer: null },

  /* ---- helpers ---- */
  validate(fieldId, ok) {
    const f = document.getElementById(fieldId);
    if (f) f.classList.toggle("invalid", !ok);
    return ok;
  },
  authError(msg) {
    const a = $("#auth-alert");
    if (a) { a.textContent = msg; a.classList.add("show"); }
  },
  creditScore(topics, attempts, avgPct) {
    let s = 520 + topics * 8 + attempts * 12 + Math.round(avgPct / 5);
    return Math.max(300, Math.min(850, s));
  },

  logout() { Auth.logout(); toast("You have been logged out."); },

  goStudy(docId, tIdx, tab) { Router.go("/study/" + docId + "/" + tIdx + "/" + tab); },

  /* ---- library filtering ---- */
  renderLibGrid() {
    const body = $("#lib-body");
    if (!body) return;
    const docs = Docs.all();
    if (!docs.length) {
      $("#lib-toolbar").style.display = "none";
      body.innerHTML = `
      <div class="empty-state">
        <div class="es-ico">&#8709;</div>
        <h3>Your study library is empty.</h3>
        <p>Upload your first PDF and Knozen AI will turn it into topics, explanations, and quizzes.</p>
        <a class="btn btn-primary btn-lg" href="#/upload">Upload your first PDF</a>
      </div>`;
      return;
    }
    $("#lib-toolbar").style.display = "";
    body.innerHTML = `<div class="lib-grid" id="lib-grid"></div>`;
    App.libFilter();
  },

  libFilter() {
    const grid = $("#lib-grid");
    if (!grid) return;
    const q = ($("#lib-search") ? $("#lib-search").value : "").toLowerCase().trim();
    const sub = $("#lib-subject") ? $("#lib-subject").value : "";
    const sort = $("#lib-sort") ? $("#lib-sort").value : "recent";
    let docs = Docs.all().filter(d =>
      (!q || d.name.toLowerCase().includes(q)) &&
      (!sub || d.subject === sub));
    if (sort === "recent") docs.sort((a, b) => b.uploadedAt - a.uploadedAt);
    if (sort === "studied") docs.sort((a, b) => (b.lastStudied || 0) - (a.lastStudied || 0));
    if (sort === "title") docs.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "progress") docs.sort((a, b) =>
      (b.topics.filter(t => t.studied).length / b.topics.length) -
      (a.topics.filter(t => t.studied).length / a.topics.length));

    if (!docs.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="es-ico">Q</div>
        <h3>No matching documents</h3>
        <p>No PDFs match your search. Try a different keyword or subject.</p>
      </div>`;
      return;
    }
    grid.innerHTML = docs.map(d => {
      const studied = d.topics.filter(t => t.studied).length;
      const pct = Math.round(studied / d.topics.length * 100);
      const atts = Attempts.forDoc(d.id);
      return `
      <div class="lib-card">
        <div class="lc-top">
          <span class="doc-thumb">PDF</span>
          <div>
            <div class="lc-title">${esc(d.name)}</div>
            <div class="lc-subject">${esc(d.subject)}</div>
          </div>
        </div>
        <div class="lc-meta">
          <span>${d.topics.length} topics &middot; ${fmtBytes(d.size)}</span>
          <span>Uploaded ${fmtDate(d.uploadedAt)} &middot; ${d.lastStudied ? "Last studied " + fmtDate(d.lastStudied) : "Not studied yet"}</span>
          <span>${atts.length ? atts.length + " quiz attempt" + (atts.length > 1 ? "s" : "") + " — best " + Math.max(...atts.map(a => a.score)) + "/" + atts[0].total : "No quizzes taken yet"}</span>
        </div>
        <div class="lc-progress-row">
          <span class="lbl">Progress</span>
          <div class="progress thin"><div class="progress-bar" style="width:${pct}%"></div></div>
          <span class="lc-pct">${pct}%</span>
        </div>
        <div class="lc-actions">
          <a class="btn btn-primary btn-sm" href="#/study/${d.id}/0/learn">${pct > 0 && pct < 100 ? "Continue Studying" : pct === 100 ? "Review" : "Start Studying"}</a>
          <button class="btn btn-danger btn-sm" onclick="App.deleteDoc('${d.id}')">Delete</button>
        </div>
      </div>`;
    }).join("");
  },

  deleteDoc(docId) {
    const d = Docs.get(docId);
    if (!d) return;
    if (!confirm("Delete \"" + d.name + "\" from your library? This cannot be undone.")) return;
    Docs.remove(docId);
    toast("Document deleted.");
    App.renderLibGrid();
  },

  /* ---- upload flow ---- */
  selectFile(file) {
    const card = $("#file-card");
    if (!card) return;
    if (App._up.timer) clearInterval(App._up.timer);
    App._up = { file: null, status: "idle", timer: null };

    if (!file) return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) return App.showFileState(file, "error", "Unsupported file — Knozen AI only accepts PDF documents.");
    if (file.size > 25 * 1024 * 1024) return App.showFileState(file, "error", "File is too large (max 25 MB).");

    App._up.file = file;
    App.showFileState(file, "waiting",
      Plans.isPro() ? "Ready to process. Included with your Pro plan."
                    : "Ready to process. This will use " + App.PROCESS_COST + " tokens.");
  },

  showFileState(file, status, message) {
    const card = $("#file-card");
    if (!card) return;
    card.classList.add("show");
    const statusClass = { waiting: "st-waiting", uploading: "st-uploading", processing: "st-processing", done: "st-done", error: "st-error" }[status];
    const label = {
      waiting: "Ready", uploading: "Uploading...", processing: "Processing...",
      done: "Completed", error: "Failed"
    }[status];
    card.innerHTML = `
      <div class="file-card-top">
        <span class="file-icon">PDF</span>
        <div class="fc-info">
          <div class="fc-name">${esc(file.name)}</div>
          <div class="fc-meta">Size: ${fmtBytes(file.size)}</div>
          <div class="fc-status ${statusClass}"><span class="dot"></span><span id="fc-status-text">${esc(message || label)}</span></div>
          <div class="progress"><div class="progress-bar" id="fc-bar"></div></div>
        </div>
      </div>
      <div class="fc-actions" id="fc-actions"></div>`;
    const actions = $("#fc-actions");
    if (status === "waiting") {
      const user = Auth.current();
      if (Plans.atFreeLimit()) {
        $("#fc-status-text").textContent = Plans.limitMsg();
        actions.innerHTML = `<a class="btn btn-primary btn-sm" href="#/plans">See plans</a>
          <button class="btn btn-ghost btn-sm" onclick="App.cancelUpload()">Remove file</button>`;
      } else if (!Plans.isPro(user) && user.tokens < App.PROCESS_COST) {
        $("#fc-status-text").textContent = "Not enough tokens. Processing needs " + App.PROCESS_COST + " — you have " + user.tokens + ".";
        actions.innerHTML = `<a class="btn btn-primary btn-sm" href="#/plans">Get tokens</a>
          <button class="btn btn-ghost btn-sm" onclick="App.cancelUpload()">Remove file</button>`;
      } else {
        actions.innerHTML = `
          <button class="btn btn-primary btn-sm" onclick="App.startProcessing()">Process &amp; Add to Library</button>
          <button class="btn btn-ghost btn-sm" onclick="App.cancelUpload()">Remove</button>`;
      }
    } else if (status === "error") {
      actions.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="App.cancelUpload()">Remove file</button>`;
    } else if (status === "done") {
      actions.innerHTML = `<span style="font-size:13px;color:var(--ok);font-weight:600">Added to your library.</span>`;
    }
  },

  cancelUpload() {
    if (App._up.timer) clearInterval(App._up.timer);
    App._up = { file: null, status: "idle", timer: null };
    const card = $("#file-card");
    if (card) { card.classList.remove("show"); card.innerHTML = ""; }
    const fi = $("#file-input"); if (fi) fi.value = "";
  },

  async startProcessing() {
    const file = App._up.file;
    if (!file || App._up.status !== "idle") return;
    const user = Auth.current();
    if (Plans.atFreeLimit()) { toast(Plans.limitMsg()); return Router.go("/plans"); }
    if (!Plans.isPro(user) && user.tokens < App.PROCESS_COST) return;

    // 1) Uploading (simulated transfer with real progress display)
    App._up.status = "uploading";
    App.showFileState(file, "uploading", "Uploading... 0%");
    let p = 0;
    await new Promise(resolve => {
      App._up.timer = setInterval(() => {
        p = Math.min(100, p + 5 + Math.random() * 12);
        const bar = $("#fc-bar"), txt = $("#fc-status-text");
        if (bar) bar.style.width = p + "%";
        if (txt) txt.textContent = "Uploading... " + Math.round(p) + "%";
        if (p >= 100) { clearInterval(App._up.timer); resolve(); }
      }, 140);
    });

    // 2) Processing — real PDF text extraction when pdf.js is available
    App._up.status = "processing";
    App.showFileState(file, "processing", "Reading PDF pages and extracting topics...");
    $("#fc-bar").style.width = "100%";
    const pages = await extractPdfPages(file);

    const built = Generator.build(file.name, pages);
    const doc = {
      id: uid(),
      ownerId: user.id,
      name: file.name,
      size: file.size,
      subject: built.subject,
      uploadedAt: Date.now(),
      lastStudied: null,
      topics: built.topics
    };

    // Deduct tokens and persist
    if (!Plans.isPro(user)) user.tokens -= App.PROCESS_COST;
    Auth.update(user);
    Docs.add(doc);

    // 3) Done
    App._up.status = "done";
    App.showFileState(file, "done", "Processing complete.");
    toast("\"" + file.name + "\" is ready — " + built.topics.length + " topics extracted.");
    setTimeout(() => Router.go("/study/" + doc.id + "/0/learn"), 1100);
  },

  /* ---- study: learn tab ---- */
  renderLearn(doc, tIdx) {
    const t = doc.topics[tIdx];
    const body = $("#tab-body");
    Sessions.add(doc.id, t.id, "read");
    body.innerHTML = `
      <div class="topic-head">
        <div class="src-line">${t.page ? "Source: Page " + t.page + " of your uploaded PDF" : "Based on your uploaded document"}</div>
        <h2><span style="color:var(--accent)">${String(tIdx + 1).padStart(2, "0")}.</span> ${esc(t.title)}</h2>
        <div class="topic-sub">${esc(doc.subject)}</div>
      </div>

      ${t.excerpt ? `
      <div class="src-quote">
        &ldquo;${esc(t.excerpt)}&hellip;&rdquo;
        <span class="src-ref">Excerpt from your document${t.page ? " &middot; p. " + t.page : ""}</span>
      </div>` : ""}

      <div class="mark-studied-row">
        <span>${t.studied ? "You have marked this topic as studied." : "Finished reading? Mark it to track your progress."}</span>
        ${t.studied
          ? `<button class="btn btn-ghost btn-sm" onclick="App.markStudied('${doc.id}',${tIdx},false)">Unmark</button>`
          : `<button class="btn btn-primary btn-sm" onclick="App.markStudied('${doc.id}',${tIdx},true)">Mark as studied</button>`}
      </div>

      <div class="study-block">
        <h3><span class="k">Short Explanation</span></h3>
        <p class="short-explain">${esc(t.short)}</p>
      </div>

      <div class="study-block">
        <h3><span class="k">Key Points</span> Remember these</h3>
        <ul class="kp-list">${t.keyPoints.map(k => `<li>${esc(k)}</li>`).join("")}</ul>
      </div>

      <div class="study-block">
        <h3><span class="k">Important Terms</span> Definitions</h3>
        <table class="terms-table">
          ${t.terms.map(x => `<tr><td class="term">${esc(x.t)}</td><td>${esc(x.d)}</td></tr>`).join("")}
        </table>
      </div>

      <div class="study-block">
        <h3><span class="k">Deep Dive</span> ${esc(t.title)}</h3>
        ${t.deepDive.map((s, i) => `
          <div class="deepdive-section">
            <h4><span class="sec-no">${String(i + 1).padStart(2, "0")}</span>${esc(s.h)}</h4>
            ${s.p.map(par => `<p>${esc(par)}</p>`).join("")}
            ${s.example ? `<div class="dd-example"><div class="ex-lbl">Worked Example</div>${esc(s.example).replace(/\n/g, "<br>")}</div>` : ""}
            ${s.why ? `<div class="dd-why"><div class="why-lbl">Why this matters</div>${esc(s.why)}</div>` : ""}
            ${s.check ? `<div class="dd-check" id="chk-${i}"><div class="chk-lbl">Knowledge Check</div><div>${esc(s.check.q)}</div><button onclick="document.getElementById('chk-${i}').classList.add('revealed');this.style.display='none'">Show answer</button><div class="chk-a">${esc(s.check.a)}</div></div>` : ""}
          </div>`).join("")}
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:22px">
        ${tIdx > 0 ? `<button class="btn btn-outline" onclick="App.goStudy('${doc.id}',${tIdx - 1},'learn')">&larr; Previous topic</button>` : ""}
        <button class="btn btn-outline" onclick="App.goStudy('${doc.id}',${tIdx},'flashcards')">Study flashcards</button>
        <button class="btn btn-primary" onclick="App.startQuiz('${doc.id}')">Take the Practice Quiz</button>
        ${tIdx < doc.topics.length - 1 ? `<button class="btn btn-outline" onclick="App.goStudy('${doc.id}',${tIdx + 1},'learn')">Next topic &rarr;</button>` : ""}
      </div>`;
  },

  markStudied(docId, tIdx, val) {
    const doc = Docs.get(docId);
    if (!doc) return;
    doc.topics[tIdx].studied = val;
    Docs.update(doc);
    if (val) { Sessions.add(docId, doc.topics[tIdx].id, "topic-complete"); toast("Topic marked as studied."); }
    // Re-render in place to update sidebar checkmarks + progress
    const tab = $(".study-tabs button.active");
    const tabName = tab ? (tab.textContent.includes("Flash") ? "flashcards" : "learn") : "learn";
    Router.render();
    App.goStudy(docId, tIdx, tabName);
  },

  /* ---- flashcards ---- */
  renderFlashcards(doc, tIdx) {
    if (!Plans.canFlashcards()) {
      $("#tab-body").innerHTML = `
        <div class="lock-panel">
          <div class="lock-ico">&#9733;</div>
          <h3>Flashcards are a paid feature</h3>
          <p>Turn every key term in this document into flip cards for quick review. Upgrade to Plus or Pro to unlock flashcards for all your PDFs.</p>
          <a class="btn btn-primary" href="#/plans">See plans</a>
        </div>`;
      return;
    }
    const t = doc.topics[tIdx];
    const cards = t.terms.map(x => ({ front: "What is \"" + x.t + "\"?", back: x.d, term: x.t }));
    App._fc = { docId: doc.id, tIdx, cards, idx: 0, flipped: false };
    App.paintFlashcard();
  },

  paintFlashcard() {
    const fc = App._fc;
    const t = Docs.get(fc.docId).topics[fc.tIdx];
    const c = fc.cards[fc.idx];
    const body = $("#tab-body");
    body.innerHTML = `
      <div class="topic-head">
        <div class="src-line">Flashcards &middot; ${esc(t.title)}</div>
        <h2>Important terms, from your document</h2>
      </div>
      <div class="flashcard">
        <div class="fc-card ${fc.flipped ? "flipped" : ""}" onclick="App.flipCard()">
          <div class="fc-tag">${fc.flipped ? "Answer" : "Term"}</div>
          ${fc.flipped
            ? `<div class="fc-back"><b style="font-family:var(--serif)">${esc(c.term)}.</b> ${esc(c.back)}</div>`
            : `<div class="fc-term">${esc(c.front)}</div>`}
          <div class="fc-hint">Tap card to ${fc.flipped ? "see the question" : "reveal the answer"}</div>
        </div>
        <div class="fc-controls">
          <button class="btn btn-outline btn-sm" onclick="App.moveCard(-1)" ${fc.idx === 0 ? "disabled" : ""}>&larr; Prev</button>
          <span class="fc-count">${fc.idx + 1} / ${fc.cards.length}</span>
          <button class="btn btn-outline btn-sm" onclick="App.moveCard(1)" ${fc.idx === fc.cards.length - 1 ? "disabled" : ""}>Next &rarr;</button>
        </div>
      </div>`;
  },
  flipCard() { App._fc.flipped = !App._fc.flipped; App.paintFlashcard(); },
  moveCard(d) {
    const fc = App._fc;
    fc.idx = Math.max(0, Math.min(fc.idx + d, fc.cards.length - 1));
    fc.flipped = false;
    App.paintFlashcard();
  },

  /* ---- quiz ---- */
  buildQuiz(doc) {
    const qs = [];
    doc.topics.forEach((t, ti) => t.questions.forEach(q => qs.push({ ...q, topic: t.title, ti })));
    // deterministic shuffle-ish: interleave topics
    return qs.slice(0, 10);
  },

  renderQuizTab(doc) {
    const body = $("#tab-body");
    const attempts = Attempts.forDoc(doc.id);
    if (!App._quiz || App._quiz.docId !== doc.id) {
      body.innerHTML = `
        <div class="quiz-shell">
          <div class="topic-head">
            <div class="src-line">Practice Quiz &middot; ${esc(doc.name)}</div>
            <h2>Test yourself on this document</h2>
            <p class="topic-sub">10 multiple-choice questions drawn from all ${doc.topics.length} topics. Every answer comes with an explanation.</p>
          </div>
          <button class="btn btn-primary btn-lg" onclick="App.startQuiz('${doc.id}')">Start Quiz</button>
          ${attempts.length ? `
          <div class="quiz-history">
            <h3 style="font-family:var(--serif);font-size:16px;margin:30px 0 10px">Your previous attempts</h3>
            <table>
              <tr><th>Date</th><th>Score</th><th>Result</th></tr>
              ${attempts.slice(0, 5).map(a => {
                const pct = Math.round(a.score / a.total * 100);
                return `<tr><td>${fmtDate(a.at)}</td>
                  <td><span class="score-pill ${pct >= 75 ? "" : pct >= 50 ? "mid" : "low"}">${a.score} / ${a.total}</span></td>
                  <td>${pct >= 75 ? "Strong — keep going" : pct >= 50 ? "Passing — review the deep dives" : "Needs review — reread the topics"}</td></tr>`;
              }).join("")}
            </table>
          </div>` : `<p style="margin-top:20px;color:var(--ink-faint);font-size:13.5px">No attempts yet — your scores will appear here.</p>`}
        </div>`;
      return;
    }
    App.paintQuestion();
  },

  startQuiz(docId) {
    const doc = Docs.get(docId);
    if (!doc) return;
    App._quiz = { docId, questions: App.buildQuiz(doc), idx: 0, score: 0, picked: null, done: false };
    App.goStudy(docId, 0, "quiz");
  },

  paintQuestion() {
    const qz = App._quiz;
    const doc = Docs.get(qz.docId);
    const q = qz.questions[qz.idx];
    const letters = ["A", "B", "C", "D"];
    const answered = qz.picked !== null;
    $("#tab-body").innerHTML = `
      <div class="quiz-shell">
        <div class="quiz-progress-head">
          <span>Question ${qz.idx + 1} of ${qz.questions.length}</span>
          <span>Score: ${qz.score}</span>
        </div>
        <div class="progress thin"><div class="progress-bar" style="width:${Math.round(qz.idx / qz.questions.length * 100)}%"></div></div>
        <div class="quiz-q">${esc(q.q)}</div>
        <div class="quiz-opts">
          ${q.opts.map((o, i) => {
            let cls = "";
            if (answered) {
              if (i === q.correct) cls = "correct";
              else if (i === qz.picked) cls = "wrong";
            }
            return `<button class="quiz-opt ${cls}" ${answered ? "disabled" : ""} onclick="App.pickOpt(${i})">
              <span class="opt-letter">${letters[i]}</span><span>${esc(o)}</span></button>`;
          }).join("")}
        </div>
        <div class="quiz-feedback ${answered ? (qz.picked === q.correct ? "ok show" : "no show") : ""}">
          <div class="fb-title">${qz.picked === q.correct ? "Correct" : "Incorrect"} — ${qz.picked === q.correct ? "well done." : "the correct answer is " + letters[q.correct] + "."}</div>
          <div>${esc(q.why)}</div>
          <div style="margin-top:8px;font-size:12.5px;color:var(--ink-faint)">Topic: ${esc(q.topic)}</div>
        </div>
        <div class="quiz-foot">
          ${answered ? `<button class="btn btn-primary" onclick="App.nextQuestion()">${qz.idx === qz.questions.length - 1 ? "Finish Quiz" : "Next Question"}</button>` : ""}
        </div>
      </div>`;
  },

  pickOpt(i) {
    const qz = App._quiz;
    if (qz.picked !== null) return;
    qz.picked = i;
    const q = qz.questions[qz.idx];
    if (i === q.correct) qz.score++;
    App.paintQuestion();
  },

  nextQuestion() {
    const qz = App._quiz;
    qz.picked = null;
    if (qz.idx === qz.questions.length - 1) return App.finishQuiz();
    qz.idx++;
    App.paintQuestion();
  },

  finishQuiz() {
    const qz = App._quiz;
    const doc = Docs.get(qz.docId);
    const total = qz.questions.length;
    Attempts.add({ id: uid(), docId: doc.id, score: qz.score, total, at: Date.now() });
    Sessions.add(doc.id, null, "quiz");
    Docs.touch(doc);
    const pct = Math.round(qz.score / total * 100);
    const msg = pct >= 90 ? "Excellent — you clearly know this material."
      : pct >= 75 ? "Strong work. Review the few you missed."
      : pct >= 50 ? "Passing, but revisit the deep dives on your weak topics."
      : "This material needs another pass — reread the topics and try again.";
    $("#tab-body").innerHTML = `
      <div class="quiz-shell">
        <div class="quiz-result">
          <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);font-weight:700">Quiz Complete</div>
          <div style="margin-top:12px"><span class="qr-score">${qz.score}</span> <span class="qr-of">/ ${total}</span></div>
          <div class="qr-msg">${msg}</div>
          <div class="qr-actions">
            <button class="btn btn-primary" onclick="App.startQuiz('${doc.id}')">Retry Quiz</button>
            <button class="btn btn-outline" onclick="App.goStudy('${doc.id}',0,'learn')">Continue Studying</button>
          </div>
        </div>
      </div>`;
    toast("Quiz saved: " + qz.score + "/" + total);
  }
};

/* ============================================================
   SUBSCRIPTIONS  (prototype — no real payments)
   - Plan lives on the user record: user.plan = "free" | "plus" | "pro"
   - user.billing holds plan / cycle / method / renewal date
   - One-time token packs add to user.tokens and log to user.purchases
   - To add a tier: add it to TIERS + PRICES, then a card in Views.plans.
   - Swap subscribe()/cancel()/buyPack() for real billing API calls later.
   ============================================================ */
const Plans = {
  TIERS: {
    free: { name: "Free", docLimit: 3,        flashcards: false, unlimited: false },
    plus: { name: "Plus", docLimit: 15,       flashcards: true,  unlimited: false, bonusTokens: 300 },
    pro:  { name: "Pro",  docLimit: Infinity, flashcards: true,  unlimited: true }
  },
  FREE_DOC_LIMIT: 3,                           // kept for older references
  PRICES: {                                    // placeholder pricing (PHP)
    plus: { monthly: 79,  yearly: 790 },
    pro:  { monthly: 149, yearly: 1190 }
  },
  PACKS: [                                     // one-time token top-ups
    { id: "s", tokens: 100, price: 49 },
    { id: "m", tokens: 300, price: 129, tag: "Popular" },
    { id: "l", tokens: 800, price: 299, tag: "Best value" }
  ],
  _cycle: "monthly",
  _checkoutPlan: "pro",

  /* ---- tier helpers ---- */
  tier(u) { u = u || Auth.current(); return u && this.TIERS[u.plan] ? u.plan : "free"; },
  isPro(u)  { return this.tier(u) === "pro"; },     // unlimited, no token charges
  isPaid(u) { return this.tier(u) !== "free"; },
  docLimit(u) { return this.TIERS[this.tier(u)].docLimit; },
  canFlashcards(u) { return this.TIERS[this.tier(u)].flashcards; },
  atDocLimit() { return Docs.all().length >= this.docLimit(); },
  atFreeLimit() { return this.atDocLimit(); },     // old name, still works
  limitMsg() {
    const t = this.tier();
    return this.TIERS[t].name + " plan limit reached (" + this.docLimit() + " PDFs). " +
      (t === "free" ? "Upgrade to Plus or Pro for more uploads." : "Upgrade to Pro for unlimited uploads.");
  },
  money(n) { return "\u20B1" + n.toLocaleString("en-US"); },
  setCycle(c) { this._cycle = c; Router.render(); },

  /* ---- modal helpers ---- */
  openModal(html) {
    this.closeModal();
    const back = document.createElement("div");
    back.className = "modal-back"; back.id = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener("click", (e) => { if (e.target === back) Plans.closeModal(); });
    document.body.appendChild(back);
  },
  closeModal() { const b = $("#modal-back"); if (b) b.remove(); },
  methodsHtml() {
    return `
      <div class="co-label">Payment method</div>
      <label class="co-method"><input type="radio" name="pm" value="GCash" checked /> GCash</label>
      <label class="co-method"><input type="radio" name="pm" value="Maya" /> Maya</label>
      <label class="co-method"><input type="radio" name="pm" value="Card" /> Credit / debit card</label>
      <p class="co-note">Prototype only &mdash; no real payment is taken and no payment details are collected.</p>`;
  },
  pickedMethod() {
    const picked = document.querySelector('input[name="pm"]:checked');
    return picked ? picked.value : "GCash";
  },

  /* ---- upgrade flow (Plus or Pro) ---- */
  openCheckout(planId) {
    planId = planId === "plus" ? "plus" : "pro";
    this._checkoutPlan = planId;
    const t = this.TIERS[planId], c = this._cycle, price = this.PRICES[planId][c];
    const user = Auth.current();
    const bonus = planId === "plus" && !(user && user.bonusClaimed) ? t.bonusTokens : 0;
    this.openModal(`
      <h3>Upgrade to Knozen ${t.name}</h3>
      <div class="co-summary">
        <div><b>Knozen ${t.name}</b><span>${c === "yearly" ? "Billed yearly" : "Billed monthly"}</span></div>
        <div class="co-price">${this.money(price)}</div>
      </div>
      ${bonus ? `<p class="co-bonus">+ ${bonus} bonus tokens added to your account today</p>` : ""}
      ${this.methodsHtml()}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="Plans.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="co-confirm" onclick="Plans.confirmCheckout()">Pay ${this.money(price)}</button>
      </div>`);
  },
  confirmCheckout() {
    const method = this.pickedMethod();
    const btn = $("#co-confirm");
    btn.disabled = true; btn.textContent = "Processing\u2026";
    setTimeout(() => {
      const user = Auth.current(); if (!user) return;
      const c = Plans._cycle, p = Plans._checkoutPlan, t = Plans.TIERS[p];
      user.plan = p;
      user.billing = {
        plan: p, cycle: c, method, price: Plans.PRICES[p][c],
        since: Date.now(), renewsAt: Date.now() + (c === "yearly" ? 365 : 30) * 86400000
      };
      if (t.bonusTokens && !user.bonusClaimed) { user.tokens += t.bonusTokens; user.bonusClaimed = true; }
      Auth.update(user);
      Plans.closeModal();
      Router.render();
      toast(p === "pro"
        ? "Welcome to Knozen Pro \u2014 unlimited uploads and flashcards unlocked."
        : "Welcome to Knozen Plus \u2014 flashcards unlocked and room for " + t.docLimit + " PDFs.");
    }, 900);
  },

  /* ---- one-time token packs ---- */
  openPack(id) {
    const pack = this.PACKS.find(p => p.id === id); if (!pack) return;
    this.openModal(`
      <h3>Buy ${pack.tokens} tokens</h3>
      <div class="co-summary">
        <div><b>${pack.tokens} Study Tokens</b><span>One-time purchase &middot; never expire</span></div>
        <div class="co-price">${this.money(pack.price)}</div>
      </div>
      ${this.methodsHtml()}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="Plans.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="co-confirm" onclick="Plans.confirmPack('${pack.id}')">Pay ${this.money(pack.price)}</button>
      </div>`);
  },
  confirmPack(id) {
    const pack = this.PACKS.find(p => p.id === id); if (!pack) return;
    const method = this.pickedMethod();
    const btn = $("#co-confirm");
    btn.disabled = true; btn.textContent = "Processing\u2026";
    setTimeout(() => {
      const user = Auth.current(); if (!user) return;
      user.tokens += pack.tokens;
      user.purchases = (user.purchases || []).concat({ pack: pack.id, tokens: pack.tokens, price: pack.price, method, at: Date.now() });
      Auth.update(user);
      Plans.closeModal();
      Router.render();
      toast(pack.tokens + " tokens added to your account.");
    }, 900);
  },

  /* ---- cancel flow ---- */
  openCancel() {
    const t = this.TIERS[this.tier()];
    const lost = this.tier() === "plus"
      ? "you'll be limited to " + this.FREE_DOC_LIMIT + " PDFs and flashcards will be locked."
      : "you'll be limited to " + this.FREE_DOC_LIMIT + " PDFs, processing will cost tokens again, and flashcards will be locked.";
    this.openModal(`
      <h3>Cancel ${t.name}?</h3>
      <p class="co-note" style="margin-top:0">You'll return to the Free plan right away. Your documents stay in your library, but ${lost}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="Plans.closeModal()">Keep ${t.name}</button>
        <button class="btn btn-danger" onclick="Plans.confirmCancel()">Cancel subscription</button>
      </div>`);
  },
  confirmCancel() {
    const user = Auth.current(); if (!user) return;
    user.plan = "free"; delete user.billing;
    Auth.update(user);
    this.closeModal();
    Router.render();
    toast("Your subscription was cancelled. You're back on the Free plan.");
  }
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") Plans.closeModal(); });

Views.plans = function (el) {
  Router.setActive("plans");
  const user = Auth.current();
  const tier = Plans.tier(user);
  const yearly = Plans._cycle === "yearly";
  const cyc = Plans._cycle;
  const plusPrice = Plans.PRICES.plus[cyc], proPrice = Plans.PRICES.pro[cyc];
  const per = yearly ? "year" : "month";
  const maxSaved = Math.max(
    Plans.PRICES.plus.monthly * 12 - Plans.PRICES.plus.yearly,
    Plans.PRICES.pro.monthly * 12 - Plans.PRICES.pro.yearly);
  const used = Docs.all().length;
  const b = user.billing;
  const plusT = Plans.TIERS.plus;

  const yes = (t) => `<li class="yes">${t}</li>`;
  const no  = (t) => `<li class="no">${t}</li>`;
  const status = () => `<div class="plan-status">Billed ${esc(b ? b.cycle : "monthly")} via ${esc(b ? b.method : "GCash")} &middot; renews ${b ? fmtDate(b.renewsAt) : "\u2014"}</div>
             <button class="btn btn-danger btn-block" onclick="Plans.openCancel()">Cancel subscription</button>`;

  el.innerHTML = `
  <div class="wrap">
    <div class="page-head">
      <h1>Plans</h1>
      <p class="lede">Start free, upgrade when you're studying from more PDFs. Cancel anytime.</p>
    </div>

    <div class="cycle-toggle" role="group" aria-label="Billing cycle">
      <button class="${!yearly ? "active" : ""}" onclick="Plans.setCycle('monthly')">Monthly</button>
      <button class="${yearly ? "active" : ""}" onclick="Plans.setCycle('yearly')">Yearly <span class="save-tag">Save up to ${Plans.money(maxSaved)}</span></button>
    </div>

    <div class="plan-grid">
      <div class="plan-card ${tier === "free" ? "current" : ""}">
        <div class="plan-name">Free</div>
        <div class="plan-price">${Plans.money(0)}<span class="plan-per">forever</span></div>
        <p class="plan-desc">For trying Knozen AI on a few documents.</p>
        <ul class="plan-feats">
          ${yes("120 starting tokens")}
          ${yes("Up to " + Plans.TIERS.free.docLimit + " PDFs in your library")}
          ${yes("Study guides &amp; deep dives")}
          ${yes("Practice quizzes with explanations")}
          ${yes("Uploads cost " + App.PROCESS_COST + " tokens each")}
          ${no("Flashcards")}
        </ul>
        ${tier === "free"
          ? `<button class="btn btn-outline btn-block" disabled>Current plan &middot; ${used}/${Plans.TIERS.free.docLimit} PDFs used</button>`
          : `<button class="btn btn-ghost btn-block" onclick="Plans.openCancel()">Downgrade to Free</button>`}
      </div>

      <div class="plan-card featured ${tier === "plus" ? "current" : ""}">
        <div class="plan-ribbon">${tier === "plus" ? "Your plan" : "Most popular"}</div>
        <div class="plan-name">Plus</div>
        <div class="plan-price">${Plans.money(plusPrice)}<span class="plan-per">/ ${per}</span></div>
        <p class="plan-desc">${yearly ? "That's about " + Plans.money(Math.round(plusPrice / 12)) + " a month." : "For students with a few subjects to review."}</p>
        <ul class="plan-feats">
          ${yes("Up to <b>" + plusT.docLimit + "</b> PDFs in your library")}
          ${yes("<b>Flashcards</b> for every topic")}
          ${yes("<b>" + plusT.bonusTokens + " bonus tokens</b> when you join")}
          ${yes("Study guides &amp; deep dives")}
          ${yes("Practice quizzes with explanations")}
          ${no("Uploads still cost " + App.PROCESS_COST + " tokens")}
        </ul>
        ${tier === "plus"
          ? status()
          : `<button class="btn btn-primary btn-block btn-lg" onclick="Plans.openCheckout('plus')">${tier === "pro" ? "Switch to Plus" : "Get Plus"}</button>`}
      </div>

      <div class="plan-card ${tier === "pro" ? "current featured" : ""}">
        <div class="plan-ribbon alt">${tier === "pro" ? "Your plan" : "Best value"}</div>
        <div class="plan-name">Pro</div>
        <div class="plan-price">${Plans.money(proPrice)}<span class="plan-per">/ ${per}</span></div>
        <p class="plan-desc">${yearly ? "That's about " + Plans.money(Math.round(proPrice / 12)) + " a month." : "For students studying from dense PDFs every week."}</p>
        <ul class="plan-feats">
          ${yes("<b>Unlimited</b> PDF uploads")}
          ${yes("No token charges for processing")}
          ${yes("<b>Flashcards</b> for every topic")}
          ${yes("Study guides &amp; deep dives")}
          ${yes("Practice quizzes with explanations")}
        </ul>
        ${tier === "pro"
          ? status()
          : `<button class="btn btn-primary btn-block btn-lg" onclick="Plans.openCheckout('pro')">Upgrade to Pro</button>`}
      </div>
    </div>

    ${tier !== "pro" ? `
    <div class="packs">
      <h2>Need more tokens?</h2>
      <p class="lede" style="margin-bottom:0">Top up any time with a one-time pack. Tokens never expire, and you don't need a subscription.</p>
      <div class="pack-grid">
        ${Plans.PACKS.map(p => `
        <div class="pack ${p.tag ? "tagged" : ""}">
          ${p.tag ? `<span class="pack-tag">${p.tag}</span>` : ""}
          <b>${p.tokens}</b>
          <span class="pack-lbl">tokens &middot; about ${Math.floor(p.tokens / App.PROCESS_COST)} uploads</span>
          <span class="pack-price">${Plans.money(p.price)}</span>
          <button class="btn btn-outline btn-block btn-sm" onclick="Plans.openPack('${p.id}')">Buy</button>
        </div>`).join("")}
      </div>
    </div>` : ""}

    <div class="faq">
      <h2>Good to know</h2>
      <details><summary>Can I cancel anytime?</summary>
        <p>Yes. Cancelling returns you to the Free plan immediately. Your documents stay in your library.</p></details>
      <details><summary>What's the difference between Plus and Pro?</summary>
        <p>Plus gives you flashcards and room for ${plusT.docLimit} PDFs, with processing paid in tokens. Pro removes every limit: unlimited PDFs and no token charges.</p></details>
      <details><summary>What happens to my tokens?</summary>
        <p>Tokens on your account are kept. On Pro they aren't used for processing; if you return to Free or Plus, you can use them again.</p></details>
      <details><summary>Do token packs expire?</summary>
        <p>No. Packs are a one-time purchase and the tokens stay on your account until you use them.</p></details>
      <details><summary>Is this real billing?</summary>
        <p>No &mdash; this is a prototype. Choosing a plan or buying tokens only changes your account on this device; no payment is taken.</p></details>
    </div>
  </div>`;
};

/* ---------------- boot ---------------- */
window.addEventListener("hashchange", () => Router.render());
document.addEventListener("DOMContentLoaded", () => Router.render());

(function(){var k="knozen-theme";if(localStorage.getItem(k)==="dark")document.documentElement.classList.add("dark");
window.toggleTheme=function(){var d=document.documentElement.classList.toggle("dark");localStorage.setItem(k,d?"dark":"light");};})();
