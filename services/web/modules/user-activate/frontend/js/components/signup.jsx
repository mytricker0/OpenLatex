import { useRef, useState } from 'react'
import { postJSON } from '@/infrastructure/fetch-json'
import { ReCaptcha2 } from '@/shared/components/recaptcha-2'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLCard from '@/shared/components/ol/ol-card'
import Notification from '@/shared/components/notification'

// Public, single-email self-service signup. Posts to the rate-limited
// /register endpoint, which creates the account and emails an activation link
// (the email is the confirmation step). We never receive or show the
// activation URL here — it only reaches the user's inbox.
function Signup() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const recaptchaRef = useRef(null)

  async function getCaptchaToken() {
    const ref = recaptchaRef.current
    if (!ref) {
      return undefined // captcha not configured — backend treats as optional
    }
    const token = await ref.executeAsync()
    ref.reset()
    return token
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      const grecaptchaResponse = await getCaptchaToken()
      await postJSON('/register', {
        body: { email, 'g-recaptcha-response': grecaptchaResponse },
      })
      setDone(true)
    } catch (err) {
      setError(
        err?.data?.message?.text ||
          'Something went wrong. Please try again in a moment.'
      )
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <OLRow>
      <OLCol lg={{ span: 6, offset: 3 }}>
        <OLCard>
          <div className="page-header">
            <h1>Sign up for OpenLatex</h1>
          </div>
          {done ? (
            <Notification
              type="success"
              content="Check your inbox — we've emailed you an activation link to set a password and finish signing up."
            />
          ) : (
            <OLForm onSubmit={handleSubmit}>
              {error ? (
                <Notification type="error" content={error} className="mb-3" />
              ) : null}
              <div className="mb-3">
                <OLFormLabel htmlFor="signup-email">Email</OLFormLabel>
                <OLFormControl
                  id="signup-email"
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@university.edu"
                />
              </div>
              <ReCaptcha2 page="register" recaptchaRef={recaptchaRef} />
              <OLButton
                type="submit"
                isLoading={isLoading}
                loadingLabel="Signing up…"
                disabled={isLoading}
              >
                Sign up — free
              </OLButton>
              <p className="mt-3 mb-0">
                Already have an account? <a href="/login">Log in</a>
              </p>
            </OLForm>
          )}
        </OLCard>
      </OLCol>
    </OLRow>
  )
}

export default Signup
