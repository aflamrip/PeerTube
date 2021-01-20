import 'multer'
import * as express from 'express'
import { auditLoggerFactory, getAuditIdFromRes, UserAuditView } from '@server/helpers/audit-logger'
import { Hooks } from '@server/lib/plugins/hooks'
import { UserUpdateMe, UserVideoRate as FormattedUserVideoRate } from '../../../../shared'
import { HttpStatusCode } from '../../../../shared/core-utils/miscs/http-error-codes'
import { UserVideoQuota } from '../../../../shared/models/users/user-video-quota.model'
import { createReqFiles } from '../../../helpers/express-utils'
import { getFormattedObjects } from '../../../helpers/utils'
import { CONFIG } from '../../../initializers/config'
import { MIMETYPES } from '../../../initializers/constants'
import { sequelizeTypescript } from '../../../initializers/database'
import { sendUpdateActor } from '../../../lib/activitypub/send'
import { deleteActorAvatarFile, updateActorAvatarFile } from '../../../lib/avatar'
import { getOriginalVideoFileTotalDailyFromUser, getOriginalVideoFileTotalFromUser, sendVerifyUserEmail } from '../../../lib/user'
import {
  asyncMiddleware,
  asyncRetryTransactionMiddleware,
  authenticate,
  paginationValidator,
  setDefaultPagination,
  setDefaultSort,
  setDefaultVideosSort,
  usersUpdateMeValidator,
  usersVideoRatingValidator
} from '../../../middlewares'
import { deleteMeValidator, videoImportsSortValidator, videosSortValidator } from '../../../middlewares/validators'
import { updateAvatarValidator } from '../../../middlewares/validators/avatar'
import { AccountModel } from '../../../models/account/account'
import { AccountVideoRateModel } from '../../../models/account/account-video-rate'
import { UserModel } from '../../../models/account/user'
import { VideoModel } from '../../../models/video/video'
import { VideoImportModel } from '../../../models/video/video-import'

const auditLogger = auditLoggerFactory('users')

const reqAvatarFile = createReqFiles([ 'avatarfile' ], MIMETYPES.IMAGE.MIMETYPE_EXT, { avatarfile: CONFIG.STORAGE.TMP_DIR })

const meRouter = express.Router()

meRouter.get('/me',
  authenticate,
  asyncMiddleware(getUserInformation)
)
meRouter.delete('/me',
  authenticate,
  deleteMeValidator,
  asyncMiddleware(deleteMe)
)

meRouter.get('/me/video-quota-used',
  authenticate,
  asyncMiddleware(getUserVideoQuotaUsed)
)

meRouter.get('/me/videos/imports',
  authenticate,
  paginationValidator,
  videoImportsSortValidator,
  setDefaultSort,
  setDefaultPagination,
  asyncMiddleware(getUserVideoImports)
)

meRouter.get('/me/videos',
  authenticate,
  paginationValidator,
  videosSortValidator,
  setDefaultVideosSort,
  setDefaultPagination,
  asyncMiddleware(getUserVideos)
)

meRouter.get('/me/videos/:videoId/rating',
  authenticate,
  asyncMiddleware(usersVideoRatingValidator),
  asyncMiddleware(getUserVideoRating)
)

meRouter.put('/me',
  authenticate,
  asyncMiddleware(usersUpdateMeValidator),
  asyncRetryTransactionMiddleware(updateMe)
)

meRouter.post('/me/avatar/pick',
  authenticate,
  reqAvatarFile,
  updateAvatarValidator,
  asyncRetryTransactionMiddleware(updateMyAvatar)
)

meRouter.delete('/me/avatar',
  authenticate,
  asyncRetryTransactionMiddleware(deleteMyAvatar)
)

// ---------------------------------------------------------------------------

export {
  meRouter
}

// ---------------------------------------------------------------------------

async function getUserVideos (req: express.Request, res: express.Response) {
  const user = res.locals.oauth.token.User

  const apiOptions = await Hooks.wrapObject({
    accountId: user.Account.id,
    start: req.query.start,
    count: req.query.count,
    sort: req.query.sort,
    search: req.query.search
  }, 'filter:api.user.me.videos.list.params')

  const resultList = await Hooks.wrapPromiseFun(
    VideoModel.listUserVideosForApi,
    apiOptions,
    'filter:api.user.me.videos.list.result'
  )

  const additionalAttributes = {
    waitTranscoding: true,
    state: true,
    scheduledUpdate: true,
    blacklistInfo: true
  }
  return res.json(getFormattedObjects(resultList.data, resultList.total, { additionalAttributes }))
}

async function getUserVideoImports (req: express.Request, res: express.Response) {
  const user = res.locals.oauth.token.User
  const resultList = await VideoImportModel.listUserVideoImportsForApi(
    user.id,
    req.query.start as number,
    req.query.count as number,
    req.query.sort
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function getUserInformation (req: express.Request, res: express.Response) {
  // We did not load channels in res.locals.user
  const user = await UserModel.loadForMeAPI(res.locals.oauth.token.user.id)

  return res.json(user.toMeFormattedJSON())
}

async function getUserVideoQuotaUsed (req: express.Request, res: express.Response) {
  const user = res.locals.oauth.token.user
  const videoQuotaUsed = await getOriginalVideoFileTotalFromUser(user)
  const videoQuotaUsedDaily = await getOriginalVideoFileTotalDailyFromUser(user)

  const data: UserVideoQuota = {
    videoQuotaUsed,
    videoQuotaUsedDaily
  }
  return res.json(data)
}

async function getUserVideoRating (req: express.Request, res: express.Response) {
  const videoId = res.locals.videoId.id
  const accountId = +res.locals.oauth.token.User.Account.id

  const ratingObj = await AccountVideoRateModel.load(accountId, videoId, null)
  const rating = ratingObj ? ratingObj.type : 'none'

  const json: FormattedUserVideoRate = {
    videoId,
    rating
  }
  return res.json(json)
}

async function deleteMe (req: express.Request, res: express.Response) {
  const user = await UserModel.loadByIdWithChannels(res.locals.oauth.token.User.id)

  auditLogger.delete(getAuditIdFromRes(res), new UserAuditView(user.toFormattedJSON()))

  await user.destroy()

  return res.sendStatus(HttpStatusCode.NO_CONTENT_204)
}

async function updateMe (req: express.Request, res: express.Response) {
  const body: UserUpdateMe = req.body
  let sendVerificationEmail = false

  const user = res.locals.oauth.token.user

  if (body.password !== undefined) user.password = body.password
  if (body.nsfwPolicy !== undefined) user.nsfwPolicy = body.nsfwPolicy
  if (body.webTorrentEnabled !== undefined) user.webTorrentEnabled = body.webTorrentEnabled
  if (body.autoPlayVideo !== undefined) user.autoPlayVideo = body.autoPlayVideo
  if (body.autoPlayNextVideo !== undefined) user.autoPlayNextVideo = body.autoPlayNextVideo
  if (body.autoPlayNextVideoPlaylist !== undefined) user.autoPlayNextVideoPlaylist = body.autoPlayNextVideoPlaylist
  if (body.videosHistoryEnabled !== undefined) user.videosHistoryEnabled = body.videosHistoryEnabled
  if (body.videoLanguages !== undefined) user.videoLanguages = body.videoLanguages
  if (body.theme !== undefined) user.theme = body.theme
  if (body.noInstanceConfigWarningModal !== undefined) user.noInstanceConfigWarningModal = body.noInstanceConfigWarningModal
  if (body.noWelcomeModal !== undefined) user.noWelcomeModal = body.noWelcomeModal

  if (body.email !== undefined) {
    if (CONFIG.SIGNUP.REQUIRES_EMAIL_VERIFICATION) {
      user.pendingEmail = body.email
      sendVerificationEmail = true
    } else {
      user.email = body.email
    }
  }

  await sequelizeTypescript.transaction(async t => {
    await user.save({ transaction: t })

    if (body.displayName !== undefined || body.description !== undefined) {
      const userAccount = await AccountModel.load(user.Account.id, t)

      if (body.displayName !== undefined) userAccount.name = body.displayName
      if (body.description !== undefined) userAccount.description = body.description
      await userAccount.save({ transaction: t })

      await sendUpdateActor(userAccount, t)
    }
  })

  if (sendVerificationEmail === true) {
    await sendVerifyUserEmail(user, true)
  }

  return res.sendStatus(HttpStatusCode.NO_CONTENT_204)
}

async function updateMyAvatar (req: express.Request, res: express.Response) {
  const avatarPhysicalFile = req.files['avatarfile'][0]
  const user = res.locals.oauth.token.user

  const userAccount = await AccountModel.load(user.Account.id)

  const avatar = await updateActorAvatarFile(userAccount, avatarPhysicalFile)

  return res.json({ avatar: avatar.toFormattedJSON() })
}

async function deleteMyAvatar (req: express.Request, res: express.Response) {
  const user = res.locals.oauth.token.user

  const userAccount = await AccountModel.load(user.Account.id)
  await deleteActorAvatarFile(userAccount)

  return res.sendStatus(HttpStatusCode.NO_CONTENT_204)
}
