import minimist from 'minimist'
import { db } from '../../../app/src/infrastructure/mongodb.mjs'
import UserRegistrationHandler from '../../../app/src/Features/User/UserRegistrationHandler.mjs'
import { fileURLToPath } from 'url'

const filename = fileURLToPath(import.meta.url)

export default async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['email'],
    boolean: ['admin'],
  })

  const { admin, email } = argv
  if (!email) {
    console.error(`Usage: node ${filename} [--admin] --email=joe@example.com`)
    process.exit(1)
  }

  const { user, setNewPasswordUrl } =
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )
  await db.users.updateOne({ _id: user._id }, { $set: { isAdmin: admin } })

  console.log('')
  console.log(`\
Successfully created ${email} as ${admin ? 'an admin' : 'a'} user.

Please visit the following URL to set a password for ${email} and log in:

  ${setNewPasswordUrl}

`)
}

if (filename === process.argv[1]) {
  try {
    await main()
    process.exit(0)
  } catch (error) {
    console.error({ error })
    process.exit(1)
  }
}
