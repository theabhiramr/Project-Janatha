**Authentication**

This is the Authentication portion of the project!

It has the following basic functionality:

1. Create Account, but only if account to create does not exist
2. Log In, but only if account to login exists
3. Delete Account

**Authentication Procedure**

Data is collected at the frontend. Username and password are concatenated and hashed. Username is also independently sent. The hash is sent to this authentication system, which salts the hash with the hash of a random string. The username is stored. The salt hash is stored, and the salted hash is rehashed. The salted hash's hash is stored along with the salt. When the user needs to log in, the same data used for account creation is sent. The salt is then retrieved. It is concatenated to the sent hash and hashed. This hash is then compared to the stored hash and a status is sent back to the front end along with a username.