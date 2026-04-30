# Instructions

You are given this small backend that simulates a minimal marketplace for buying tickets.
We want to see what you can do with it.
There are no strict instructions, no fixed requirements, that is up to you.

Show us what you can do.

Check the APIs available and come up with a plan for a small app that uses them. Then implement it in a small app.
- You should not spend more than a day on this assignment
- If your idea takes longer, scrap something. We understand nobody has infinite time.
- You do not necessarily have to use all the APIs.
- The final product should make sense as a POC for a small marketplace app.
- You will be judged based on your implementation idea and code quality.
- Focus on code first, UX later.
- You are free to use AI to code your solution, we encourage you to do so in order to save time. But remember we might ask you questions about your code. So take your time to understand your code, you are responsible for the code you send us.
- If you use AI, please share some of your prompt. Add a PROMPTS.txt file to the final assignment.
- Do not change this backend code in any way. Use it as is.
- Once done, zip your project (make sure you clean first) and send it to us.

## Data source
All data returned by the API is read at startup from one of the json files:
- `data.json` : Data about events and available tickets.
- `users.json` : Data about registered users, this backend does not allow registration, only log in by existing users.
- `venues.json` : Data about venues.

## How to start this backend
- `npm install`
- `npm start`

Once started, you can inspect the GraphQL APIs available to you by using GraphiQL at http://localhost:4000/graphql.
