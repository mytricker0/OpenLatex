import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserRegistrationHandler from '../../../../app/src/Features/User/UserRegistrationHandler.mjs'
import ErrorController from '../../../../app/src/Features/Errors/ErrorController.mjs'
import { expressify } from '@overleaf/promise-utils'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

function registerNewUser(req, res, next) {
  res.render(Path.resolve(__dirname, '../views/user/register'))
}

async function register(req, res, next) {
  const { email } = req.body
  if (email == null || email === '') {
    return res.sendStatus(422) // Unprocessable Entity
  }
  const { user, setNewPasswordUrl } =
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )
  res.json({
    email: user.email,
    setNewPasswordUrl,
  })
}

async function publicRegister(req, res, next) {
  const { email } = req.body
  if (email == null || email === '') {
    return res.sendStatus(422)
  }
  try {
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )
  } catch (error) {
    if (/invalid email/i.test(error.message)) {
      return res.status(400).json({
        message: { type: 'error', text: 'That email address looks invalid.' },
      })
    }
    throw error
  }
  // SECURITY: never return setNewPasswordUrl on the public endpoint — it is the
  // account-activation (password-set) link and must only reach the inbox. The
  // response is identical whether or not the email already existed, so this
  // cannot be used to enumerate accounts.
  res.json({
    message: {
      type: 'notice',
      text: "If that address is valid, we've emailed an activation link. Check your inbox to set a password and finish signing up.",
    },
  })
}

async function activateAccountPage(req, res, next) {
  // An 'activation' is actually just a password reset on an account that
  // was set with a random password originally.
  if (req.query.user_id == null || req.query.token == null) {
    return ErrorController.notFound(req, res)
  }

  if (typeof req.query.user_id !== 'string') {
    return ErrorController.forbidden(req, res)
  }

  const user = await UserGetter.promises.getUser(req.query.user_id, {
    email: 1,
    loginCount: 1,
  })

  if (!user) {
    return ErrorController.notFound(req, res)
  }

  if (user.loginCount > 0) {
    // Already seen this user, so account must be activated.
    // This lets users keep clicking the 'activate' link in their email
    // as a way to log in which, if I know our users, they will.
    return res.redirect(`/login`)
  }

  req.session.doLoginAfterPasswordReset = true

  res.render(Path.resolve(__dirname, '../views/user/activate'), {
    title: 'activate_account',
    email: user.email,
    token: req.query.token,
  })
}

export default {
  registerNewUser,
  register: expressify(register),
  publicRegister: expressify(publicRegister),
  activateAccountPage: expressify(activateAccountPage),
}
