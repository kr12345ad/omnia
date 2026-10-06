// The banner lockup: the mark on the left, the wordmark on the right, drawn
// five rows tall so the mark's corner block has room. Every line of each half
// is padded to one fixed width so the renderer can pair the halves row by row.
// The single trailing space on the left is half of the two-column gap; each
// consumer already inserts one space of its own between the halves.
export const logo = {
  left: ["█▀▀▀▀▀█ ", "█     █ ", "█   ███ ", "█   ███ ", "█▀▀▀▀▀█ "],
  right: [
    "█▀▀█ █   █ █   █ ███ ▄▀▀▀▄",
    "█__█ █▄ ▄█ ██  █  █  █   █",
    "█^^█ █ █ █ █ █ █  █  █▀▀▀█",
    "█__█ █   █ █  ██  █  █   █",
    "▀▀▀▀ █   █ █   █ ███ █   █",
  ],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
