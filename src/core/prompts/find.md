The user is looking for one of their own past conversations. Each line below is one saved
conversation, in the form:

`id | date | people | title | first message excerpt`

Catalogue:
{{catalogue}}

They asked:
{{question}}

Answer in two parts:

1. A short answer naming the conversations that fit and why — mention the people and the date,
   because that is how the user will recognise it. If nothing fits, say so plainly instead of
   offering the closest line; a wrong match costs more than "not found".
2. A final line, exactly:

`MATCHES: <ids separated by commas>`

Use only ids that appear in the catalogue. Write `MATCHES:` with nothing after it when none fit.
Judge only by what the lines say; you cannot read the conversations themselves.
