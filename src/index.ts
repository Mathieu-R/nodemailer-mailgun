import Mailgun from 'mailgun.js';
import formData from 'form-data';
import type { Transport, SendMailOptions } from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';
import type { CustomFile, MailgunMessageData } from 'mailgun.js/Types/Messages/index.js';

export interface MailgunTransportOptions {
  url?: string;
  host?: string;
  protocol?: 'http:' | 'https:';
  port?: number;
  auth:
    | {
        api_key: string;
        domain: string;
      }
    | {
        apiKey: string;
        domain: string;
      };
  timeout?: number;
}
export type MailgunTransportSendMailOptions = Omit<
  SendMailOptions,
  'attachments'
> & {
  attachments?: MailAttachment[];
};
type MailAttachment = Attachment & {
  knownLength?: number;
};

const whitelist: ([string | RegExp, string | undefined] | [string | RegExp])[] =
  [
    ['replyTo', 'h:Reply-To'],
    ['messageId', 'h:Message-Id'],
    [/^h:/],
    [/^v:/],
    ['from'],
    ['to'],
    ['cc'],
    ['bcc'],
    ['subject'],
    ['text'],
    ['template'],
    ['html'],
    ['attachment'],
    ['inline'],
    ['recipient-variables'],
    ['o:tag'],
    ['o:campaign'],
    ['o:dkim'],
    ['o:deliverytime'],
    ['o:testmode'],
    ['o:tracking'],
    ['o:tracking-clicks'],
    ['o:tracking-opens'],
    ['o:require-tls'],
    ['o:skip-verification'],
    ['X-Mailgun-Variables'],
    ['priority'],
  ];

const applyKeyWhitelist = (mail: SendMailOptions): MailgunMessageData =>
  Object.keys(mail).reduce((acc, key) => {
    const targetKey = whitelist.reduce((result, [cond, target]) => {
      if (result) {
        return result;
      }
      if (
        typeof cond === 'string' ? cond === key : cond.exec && cond.exec(key)
      ) {
        return target || key;
      }
      return undefined;
    }, undefined as any);
    if (!targetKey || !mail[key as keyof SendMailOptions]) {
      return acc;
    }
    return { ...acc, [targetKey]: mail[key as keyof SendMailOptions] };
  }, {} as MailgunMessageData);

const makeMailgunAttachments = (
  attachments: MailAttachment[] = []
): Pick<MailgunMessageData, 'attachment' | 'inline'> => {
  const [attachment, inline] = attachments.reduce(
    (results, item) => {
      const data =
        typeof item.content === 'string'
          ? Buffer.from(item.content, item.encoding as BufferEncoding)
          : item.content || undefined;
      if (!data) {
        if (item.path) {
          throw new Error('Mailgun does not support file paths');
        }
        return results;
      }
      const attachment: CustomFile = {
        data,
        filename: item.cid || item.filename || undefined,
        contentType: item.contentType || undefined,
        knownLength: item.knownLength || undefined,
      };
      const [attachmentAttachments, inlineAttachments] = results;
      return [
        attachmentAttachments.concat(!item.cid ? attachment : []),
        inlineAttachments.concat(item.cid ? attachment : []),
      ];
    },
    [[] as CustomFile[], [] as any[]]
  );
  return {
    ...(attachment.length ? { attachment } : {}),
    ...(inline.length ? { inline } : {}),
  };
};

const makeTextAddresses = (addresses: SendMailOptions['to']) => {
  const validAddresses = [
    ...(Array.isArray(addresses) ? addresses : [addresses]),
  ].filter(Boolean);
  const textAddresses = validAddresses.map((item) =>
    item && typeof item === 'object'
      ? item.name
        ? item.name + ' <' + item.address + '>'
        : item.address
      : typeof item === 'string'
      ? item
      : null
  );
  return textAddresses.filter(Boolean).join();
};
const makeAllTextAddresses = (
  mail: SendMailOptions
): Pick<MailgunMessageData, 'from' | 'to' | 'cc' | 'bcc'> & {
  replyTo?: string;
} => ({
  ...mail,
  from: makeTextAddresses(mail.from),
  to: makeTextAddresses(mail.to),
  cc: makeTextAddresses(mail.cc),
  bcc: makeTextAddresses(mail.bcc),
  replyTo: makeTextAddresses(mail.replyTo),
});

export const getMailgunTransport = (options: MailgunTransportOptions): Transport => {
  const mailgun = new Mailgun(formData);
  let url = options.url;
  if (!options.url && options.host) {
    const generatedUrl = new URL(
      'https://' + (options.host || 'api.mailgun.net')
    );
    generatedUrl.protocol = options.protocol || 'https:';
    generatedUrl.port = `${options.port}` || '443';
    url = generatedUrl.href;
  }
  const messages = mailgun.client({
    username: 'api',
    key: 'api_key' in options.auth ? options.auth.api_key : options.auth.apiKey,
    url,
    timeout: options.timeout,
  }).messages;

  return {
    name: 'Mailgun',
    send: ({ data: mail }, callback) => {
      Promise.resolve()
        .then(async () => {
          const { priority, ...whitelistedMail }: MailgunMessageData =
            applyKeyWhitelist({
              ...mail,
              ...makeAllTextAddresses(mail),
              ...makeMailgunAttachments(mail.attachments),
            });

          const prioritisedMail: MailgunMessageData =
            priority === 'high'
              ? {
                  ...whitelistedMail,
                  'h:X-Priority': '1 (Highest)',
                  'h:X-MSMail-Priority': 'High',
                  'h:Importance': 'High',
                }
              : priority === 'low'
              ? {
                  ...whitelistedMail,
                  'h:X-Priority': '5 (Lowest)',
                  'h:X-MSMail-Priority': 'Low',
                  'h:Importance': 'Low',
                }
              : whitelistedMail;

          const result = await messages.create(
            options.auth.domain || '',
            prioritisedMail
          );
          return result;
        })
        .then((result) => callback(null, { ...result, messageId: result.id }))
        .catch((error) => callback(error, null));
    },
    version: '1.0.0',
  };
};
