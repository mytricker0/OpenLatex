import logger from '@overleaf/logger'
import UserActivateController from './UserActivateController.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import CaptchaMiddleware from '../../../../app/src/Features/Captcha/CaptchaMiddleware.mjs'

// Public self-service signup caps (OpenLatex). Open registration is not a
// stock CE feature; these protect the instance from abuse:
//  - per IP: throttle one source hammering signups / spamming activation mail
//  - global: hard ceiling on new accounts/day, matched to the Brevo free tier
//    (300 emails/day) so we never silently fail to send activation mail.
const publicRegisterIpLimiter = new RateLimiter('public-register-ip', {
  points: 20,
  duration: 24 * 60 * 60,
})
const publicRegisterGlobalLimiter = new RateLimiter('public-register-global', {
  points: 300,
  duration: 24 * 60 * 60,
})

function globalDailySignupCap(req, res, next) {
  publicRegisterGlobalLimiter
    .consume('global', 1, { method: 'global' })
    .then(() => next())
    .catch(err => {
      if (err instanceof Error) {
        return next(err) // redis/backend error — fail closed via error handler
      }
      // RateLimiterRes rejection => limit reached
      res.status(429).json({
        message: {
          type: 'error',
          text: 'Daily signup limit reached. Please try again tomorrow.',
        },
      })
    })
}

export default {
  apply(webRouter) {
    logger.debug({}, 'Init UserActivate router')

    webRouter.get(
      '/admin/user',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      (req, res) => res.redirect('/admin/register')
    )

    webRouter.get('/user/activate', UserActivateController.activateAccountPage)
    AuthenticationController.addEndpointToLoginWhitelist('/user/activate')

    // Public self-service registration. The register page form posts here.
    // captcha first (inert until RECAPTCHA keys are configured), then the
    // per-IP and global daily caps, then create-user-and-email-activation.
    AuthenticationController.addEndpointToLoginWhitelist('/register')
    webRouter.post(
      '/register',
      CaptchaMiddleware.validateCaptcha('register'),
      RateLimiterMiddleware.rateLimit(publicRegisterIpLimiter),
      globalDailySignupCap,
      UserActivateController.publicRegister
    )

    // Admin-only account creation tool (unchanged): create a user directly.
    webRouter.get(
      '/admin/register',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.registerNewUser
    )
    webRouter.post(
      '/admin/register',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserActivateController.register
    )
  },
}
